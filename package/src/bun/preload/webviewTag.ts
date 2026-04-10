// <electrobun-webview> Custom Element
// Provides OOPIF (out-of-process iframe) functionality

import "./globals.d.ts";
import { send, request } from "./internalRpc";
import { OverlaySyncController, type Rect } from "./overlaySync";

// ---------------------------------------------------------------------------
// Auto-mask: document-wide tracker for host HTML elements that are candidates
// for automatically masking native webviews. When a <electrobun-webview> has
// the `auto-mask` attribute, the getMasks closure consults this set so that
// any positioned host overlay (dropdown, dialog, popover, tooltip) that
// happens to overlap the webview automatically punches a hole in it — no
// per-component `addMaskSelector` wiring required.
//
// The tracker is intentionally module-scoped: one MutationObserver per
// document is sufficient regardless of how many webviews are listening.
// ---------------------------------------------------------------------------
const overlayCandidates = new Set<HTMLElement>();
const autoMaskListeners = new Set<() => void>();
let overlayObserver: MutationObserver | null = null;
let notifyScheduled = false;

function isPositioned(el: HTMLElement): boolean {
	// getComputedStyle is the only reliable way to detect position — class-
	// and stylesheet-driven layouts can't be inferred from inline attributes.
	// This is expensive per call, which is why we cache membership in
	// `overlayCandidates` and only re-check on mutations.
	const cs = getComputedStyle(el);
	return cs.position === "absolute" || cs.position === "fixed";
}

function isOverlayCandidate(el: Element): el is HTMLElement {
	if (!(el instanceof HTMLElement)) return false;
	if (el.tagName === "ELECTROBUN-WEBVIEW") return false;
	if (el.hasAttribute("data-electrobun-no-mask")) return false;
	return isPositioned(el);
}

function isVisibleOverlay(el: HTMLElement): boolean {
	if (!el.isConnected) return false;
	// Prefer the native Element.checkVisibility when available — it walks
	// ancestors and respects display/visibility/opacity/content-visibility
	// correctly, which is critical for apps that keep hidden UI mounted
	// behind an opacity-0 wrapper (a common "preserve state" pattern in
	// React SPAs). Without this, a positioned descendant of an opacity-0
	// ancestor is reported as visible and ends up masking the webview.
	const cv = (el as unknown as {
		checkVisibility?: (options?: object) => boolean;
	}).checkVisibility;
	if (typeof cv === "function") {
		return cv.call(el, {
			opacityProperty: true,
			visibilityProperty: true,
			contentVisibilityAuto: true,
		});
	}
	// Fallback: walk ancestors manually. Expensive, but only runs on
	// browsers older than Safari 17.4 / Chrome 105.
	let cur: HTMLElement | null = el;
	while (cur) {
		const cs = getComputedStyle(cur);
		if (cs.display === "none") return false;
		if (cs.visibility === "hidden" || cs.visibility === "collapse") return false;
		const op = parseFloat(cs.opacity);
		if (!isNaN(op) && op === 0) return false;
		cur = cur.parentElement;
	}
	return true;
}

function scanSubtree(root: Element) {
	if (root instanceof HTMLElement && isOverlayCandidate(root)) {
		overlayCandidates.add(root);
	}
	root.querySelectorAll?.("*").forEach((el) => {
		if (isOverlayCandidate(el)) overlayCandidates.add(el);
	});
}

function unscanSubtree(root: Element) {
	if (root instanceof HTMLElement) overlayCandidates.delete(root);
	root.querySelectorAll?.("*").forEach((el) => {
		if (el instanceof HTMLElement) overlayCandidates.delete(el);
	});
}

function scheduleAutoMaskNotify() {
	if (notifyScheduled) return;
	notifyScheduled = true;
	requestAnimationFrame(() => {
		notifyScheduled = false;
		autoMaskListeners.forEach((fn) => fn());
	});
}

function ensureOverlayObserver() {
	if (overlayObserver || !document.body) return;
	scanSubtree(document.body);
	overlayObserver = new MutationObserver((mutations) => {
		let changed = false;
		for (const m of mutations) {
			if (m.type === "childList") {
				m.addedNodes.forEach((n) => {
					if (n instanceof Element) {
						scanSubtree(n);
						changed = true;
					}
				});
				m.removedNodes.forEach((n) => {
					if (n instanceof Element) {
						unscanSubtree(n);
						changed = true;
					}
				});
			} else if (m.type === "attributes" && m.target instanceof HTMLElement) {
				const el = m.target;
				const was = overlayCandidates.has(el);
				const now = isOverlayCandidate(el);
				if (was !== now) {
					if (now) overlayCandidates.add(el);
					else overlayCandidates.delete(el);
					changed = true;
				}
			}
		}
		if (changed) scheduleAutoMaskNotify();
	});
	overlayObserver.observe(document.body, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["style", "class", "data-electrobun-no-mask"],
	});
}

function registerAutoMaskListener(fn: () => void): () => void {
	autoMaskListeners.add(fn);
	if (document.body) {
		ensureOverlayObserver();
	} else {
		document.addEventListener("DOMContentLoaded", ensureOverlayObserver, {
			once: true,
		});
	}
	return () => {
		autoMaskListeners.delete(fn);
		// Intentionally leave overlayObserver connected — it's cheap when
		// idle and we'd otherwise thrash setup/teardown as webviews come
		// and go during navigation.
	};
}

/**
 * Does this element have a non-transparent CSS background color?
 *
 * Used to distinguish between "visible overlays" (modals, dropdowns, palette
 * boxes — things the user should see) and "transparent click catchers"
 * (full-viewport wrappers whose only job is to catch clicks for dismissal).
 * When a candidate is a click catcher we want to mask its *visible children*
 * instead of itself, so the rest of the webview stays visible around the
 * actual popup.
 */
function hasVisibleBackground(el: HTMLElement): boolean {
	const bg = getComputedStyle(el).backgroundColor;
	if (!bg || bg === "transparent") return false;
	const m = bg.match(/^rgba?\(([^)]+)\)$/);
	if (!m) return true; // named color, hex, etc. — treat as visible
	const parts = m[1]!.split(",").map((s) => parseFloat(s.trim()));
	if (parts.length === 4) return parts[3]! > 0;
	return true; // rgb() without alpha is fully opaque
}

/**
 * Collect mask rects for a subtree rooted at `el`.
 *
 * If `el` has its own visible background it is treated as a self-contained
 * overlay (modal backdrop, dropdown, palette box, etc.) and its own rect is
 * used. Otherwise we recurse into its children looking for visible
 * descendants — this handles the click-catcher-wrapping-a-palette pattern
 * where the positioned wrapper is transparent and the actual visible popup
 * is a static-positioned child inside it.
 *
 * Results are pushed into `out` as rects relative to `webviewRect`.
 */
function collectOverlayRects(
	el: HTMLElement,
	webviewRect: { x: number; y: number; width: number; height: number },
	out: Rect[],
) {
	if (!isVisibleOverlay(el)) return;
	if (hasVisibleBackground(el)) {
		const mr = el.getBoundingClientRect();
		if (mr.width > 0 && mr.height > 0) {
			out.push({
				x: mr.x - webviewRect.x,
				y: mr.y - webviewRect.y,
				width: mr.width,
				height: mr.height,
			});
		}
		// Don't recurse into a visible container — its descendants are
		// already covered by the outer rect, and dropContainedRects would
		// drop them anyway.
		return;
	}
	// Transparent wrapper: recurse into children looking for actual visible
	// overlay content (e.g. a centered palette box inside a full-viewport
	// click catcher).
	for (let i = 0; i < el.children.length; i++) {
		const child = el.children[i];
		if (child instanceof HTMLElement) {
			collectOverlayRects(child, webviewRect, out);
		}
	}
}

function rectsOverlap(a: Rect, b: Rect): boolean {
	return !(
		a.x + a.width <= b.x ||
		b.x + b.width <= a.x ||
		a.y + a.height <= b.y ||
		b.y + b.height <= a.y
	);
}

function rectContains(outer: Rect, inner: Rect): boolean {
	return (
		outer.x <= inner.x &&
		outer.y <= inner.y &&
		outer.x + outer.width >= inner.x + inner.width &&
		outer.y + outer.height >= inner.y + inner.height
	);
}

/**
 * Drop mask rects that are strictly contained within another mask rect.
 *
 * The native side composes the final mask path with kCAFillRuleEvenOdd,
 * which means overlapping rects XOR back to "visible". A modal backdrop
 * with a nested dialog would therefore fail to mask the dialog's area.
 * Collapsing contained rects yields a correct rendering for the common
 * nested-overlay pattern at the cost of masking slightly more of the
 * webview than strictly necessary (the backdrop "wins" over the dialog,
 * which is usually what the user wants anyway).
 */
function dropContainedRects(rects: Rect[]): Rect[] {
	if (rects.length <= 1) return rects;
	return rects.filter((inner, i) => {
		for (let j = 0; j < rects.length; j++) {
			if (i === j) continue;
			const outer = rects[j]!;
			if (
				rectContains(outer, inner) &&
				!(rectContains(inner, outer) && i < j)
			) {
				return false;
			}
		}
		return true;
	});
}

const AUTO_MASK_RECT_LIMIT = 100;

type WebviewEventType =
	| "will-navigate"
	| "did-navigate"
	| "did-navigate-in-page"
	| "did-commit-navigation"
	| "dom-ready"
	| "new-window-open"
	| "host-message"
	| "download-started"
	| "download-progress"
	| "download-completed"
	| "download-failed"
	| "load-started"
	| "load-committed"
	| "load-finished";

// Registry for webview instances (for event routing from bun)
export const webviewRegistry: Record<number, ElectrobunWebviewTag> = {};

export class ElectrobunWebviewTag extends HTMLElement {
	webviewId: number | null = null;
	maskSelectors: Set<string> = new Set();
	private _sync: OverlaySyncController | null = null;
	transparent = false;
	passthroughEnabled = false;
	hidden = false;
	// Auto-mask: when true, any positioned host HTML element overlapping
	// this webview is automatically added to the mask list without needing
	// explicit addMaskSelector calls.
	autoMaskEnabled = false;
	private _autoMaskUnsubscribe: (() => void) | null = null;
	// Tracks whether auto-mask has opted us into passthrough mode because
	// a full-viewport transparent click-catcher is currently open over the
	// webview (e.g. a command palette / modal dismiss layer).
	private _autoPassthroughActive = false;
	// Sandbox mode: when true, disables RPC and only allows event emission in the child webview
	sandboxed = false;
	private _eventListeners: Record<string, Array<(event: CustomEvent) => void>> =
		{};

	constructor() {
		super();
	}

	connectedCallback() {
		requestAnimationFrame(() => this.initWebview());
	}

	disconnectedCallback() {
		if (this.webviewId !== null) {
			send("webviewTagRemove", { id: this.webviewId });
			delete webviewRegistry[this.webviewId];
		}
		if (this._sync) this._sync.stop();
		if (this._autoMaskUnsubscribe) {
			this._autoMaskUnsubscribe();
			this._autoMaskUnsubscribe = null;
		}
	}

	async initWebview() {
		const rect = this.getBoundingClientRect();
		const initialRect = {
			x: rect.x,
			y: rect.y,
			width: rect.width,
			height: rect.height,
		};

		const url = this.getAttribute("src");
		const html = this.getAttribute("html");
		const preload = this.getAttribute("preload");
		const partition = this.getAttribute("partition");
		const renderer = (this.getAttribute("renderer") || "native") as
			| "native"
			| "cef";
		const masks = this.getAttribute("masks");
		// Sandbox attribute: when present, the child webview is sandboxed (no RPC, events only)
		const sandbox = this.hasAttribute("sandbox");
		this.sandboxed = sandbox;
		// Read transparent/passthrough attributes for initial state (avoids flash)
		const transparent = this.hasAttribute("transparent");
		const passthrough = this.hasAttribute("passthrough");
		this.transparent = transparent;
		this.passthroughEnabled = passthrough;
		if (transparent) this.style.opacity = "0";
		if (passthrough) this.style.pointerEvents = "none";

		if (masks) {
			masks.split(",").forEach((s) => this.maskSelectors.add(s.trim()));
		}

		this.autoMaskEnabled = this.hasAttribute("auto-mask");
		if (this.autoMaskEnabled) {
			// Auto-mask assumes the host HTML may render meaningful pixels at
			// the webview's coordinates (backdrops, click catchers, empty
			// layout background). The default white `background: #fff` from
			// the shared stylesheet would be revealed through mask holes as
			// an opaque white flash when a full-viewport overlay opens over
			// the webview. Force a transparent background so holes reveal
			// whatever the host is actually drawing.
			this.style.background = "transparent";
		}

		try {
			const webviewId = (await request("webviewTagInit", {
				hostWebviewId: window.__electrobunWebviewId,
				windowId: window.__electrobunWindowId,
				renderer,
				url,
				html,
				preload,
				partition,
				frame: {
					width: rect.width,
					height: rect.height,
					x: rect.x,
					y: rect.y,
				},
				navigationRules: null,
				sandbox,
				transparent,
				passthrough,
			})) as number;

			this.webviewId = webviewId;
			this.id = `electrobun-webview-${webviewId}`;
			webviewRegistry[webviewId] = this;

			this.setupObservers(initialRect);

			if (this.autoMaskEnabled) {
				this._autoMaskUnsubscribe = registerAutoMaskListener(() => {
					this.syncDimensions(true);
				});
			}

			// Force immediate sync after initialization
			this.syncDimensions(true);

			// When adding a new webview, force all existing webviews to re-sync their positions
			// This handles layout changes caused by the new webview
			// Use requestAnimationFrame to ensure DOM layout is complete
			requestAnimationFrame(() => {
				Object.values(webviewRegistry).forEach((webview) => {
					if (webview !== this && webview.webviewId !== null) {
						webview.syncDimensions(true);
					}
				});
			});
		} catch (err) {
			console.error("Failed to init webview:", err);
		}
	}

	setupObservers(initialRect: Rect) {
		const getMasks = () => {
			const rect = this.getBoundingClientRect();
			const masks: Rect[] = [];

			// Manual selectors registered via the `masks` attribute or
			// addMaskSelector(). These are always honored, regardless of
			// whether auto-mask is enabled.
			this.maskSelectors.forEach((selector) => {
				try {
					document.querySelectorAll(selector).forEach((el) => {
						const mr = el.getBoundingClientRect();
						masks.push({
							x: mr.x - rect.x,
							y: mr.y - rect.y,
							width: mr.width,
							height: mr.height,
						});
					});
				} catch (_e) {
					// Invalid selector, ignore
				}
			});

			// Auto-mask: walk the cached set of positioned host elements and
			// turn overlapping popups into mask rects. For each candidate we
			// either mask its own rect (if it has visible content) or descend
			// into its descendants looking for visible rects (the transparent
			// wrapper case — e.g. a command palette wrapped in a full-viewport
			// click catcher).
			//
			// We also detect the "modal wrapper" pattern (a positioned element
			// whose rect covers the entire webview) and switch the webview
			// into pointer-events passthrough mode so clicks land on the host
			// HTML. That makes click-to-dismiss work for palettes, dialogs,
			// and dropdowns without requiring them to use the old "hide the
			// whole webview" hack.
			let wantsPassthrough = false;
			if (this.autoMaskEnabled) {
				const viewportRect = {
					x: 0,
					y: 0,
					width: rect.width,
					height: rect.height,
				};
				let count = 0;
				outer: for (const el of overlayCandidates) {
					if (count >= AUTO_MASK_RECT_LIMIT) {
						console.warn(
							`[electrobun] auto-mask exceeded ${AUTO_MASK_RECT_LIMIT} candidates; ` +
								"additional overlays will not be masked. Consider narrowing " +
								"which elements use position:absolute/fixed.",
						);
						break;
					}
					if (!isVisibleOverlay(el)) continue;
					// Ancestors wrap the webview rather than overlay it;
					// masking them would punch a hole where the webview
					// itself lives.
					if (el.contains(this)) continue;
					// Elements inside another webview's host DOM aren't
					// part of this host document's paint order.
					if (el !== this && el.closest("electrobun-webview")) continue;

					const wrapperRect = el.getBoundingClientRect();
					const coversWebview =
						wrapperRect.x <= rect.x + 0.5 &&
						wrapperRect.y <= rect.y + 0.5 &&
						wrapperRect.x + wrapperRect.width >=
							rect.x + rect.width - 0.5 &&
						wrapperRect.y + wrapperRect.height >=
							rect.y + rect.height - 0.5;

					const collected: Rect[] = [];
					if (coversWebview) {
						// Don't mask the wrapper itself — that would hide the
						// browser. Instead recurse into its descendants to
						// find the actual visible popup content, and flip on
						// passthrough so clicks route through to the host.
						wantsPassthrough = true;
						for (let i = 0; i < el.children.length; i++) {
							const child = el.children[i];
							if (child instanceof HTMLElement) {
								collectOverlayRects(child, rect, collected);
							}
						}
					} else {
						collectOverlayRects(el, rect, collected);
					}
					if (collected.length === 0) continue;

					// If this candidate produced a mask rect AND is
					// interactive (pointer-events != none), enable
					// passthrough so click-outside dismissal works for
					// dropdown menus and other popovers whose wrappers
					// aren't full-viewport. Decorative tooltips that use
					// pointer-events: none are left alone so the browser
					// stays interactive while they're visible.
					if (!wantsPassthrough) {
						if (getComputedStyle(el).pointerEvents !== "none") {
							wantsPassthrough = true;
						}
					}
					for (const r of collected) {
						if (count >= AUTO_MASK_RECT_LIMIT) {
							console.warn(
								`[electrobun] auto-mask exceeded ${AUTO_MASK_RECT_LIMIT} candidates; ` +
									"additional overlays will not be masked.",
							);
							break outer;
						}
						if (!rectsOverlap(r, viewportRect)) continue;
						masks.push(r);
						count++;
					}
				}
			}

			// Flip passthrough to match what we detected. This happens as a
			// side effect inside getMasks so the native pointer-events flip
			// is coupled to the same sync tick as the mask update.
			if (
				this.autoMaskEnabled &&
				wantsPassthrough !== this._autoPassthroughActive
			) {
				this._autoPassthroughActive = wantsPassthrough;
				this.togglePassthrough(wantsPassthrough);
			}

			return dropContainedRects(masks);
		};

		this._sync = new OverlaySyncController(this, {
			onSync: (rect, masksJson) => {
				if (this.webviewId === null) return;
				send("webviewTagResize", {
					id: this.webviewId,
					frame: rect,
					masks: masksJson,
				});
			},
			getMasks,
			burstIntervalMs: 10,
			baseIntervalMs: 100,
			burstDurationMs: 50,
		});
		this._sync.setLastRect(initialRect);
		this._sync.start();
	}

	syncDimensions(force = false) {
		if (!this._sync) return;
		if (force) {
			this._sync.forceSync();
		}
	}

	// Navigation methods
	loadURL(url: string) {
		if (this.webviewId === null) return;
		this.setAttribute("src", url);
		send("webviewTagUpdateSrc", { id: this.webviewId, url });
	}

	loadHTML(html: string) {
		if (this.webviewId === null) return;
		send("webviewTagUpdateHtml", { id: this.webviewId, html });
	}

	reload() {
		if (this.webviewId !== null)
			send("webviewTagReload", { id: this.webviewId });
	}

	goBack() {
		if (this.webviewId !== null)
			send("webviewTagGoBack", { id: this.webviewId });
	}

	goForward() {
		if (this.webviewId !== null)
			send("webviewTagGoForward", { id: this.webviewId });
	}

	async canGoBack(): Promise<boolean> {
		if (this.webviewId === null) return false;
		return (await request("webviewTagCanGoBack", {
			id: this.webviewId,
		})) as boolean;
	}

	async canGoForward(): Promise<boolean> {
		if (this.webviewId === null) return false;
		return (await request("webviewTagCanGoForward", {
			id: this.webviewId,
		})) as boolean;
	}

	// Visibility methods
	toggleTransparent(value?: boolean) {
		if (this.webviewId === null) return;
		this.transparent = value !== undefined ? value : !this.transparent;
		this.style.opacity = this.transparent ? "0" : "";
		send("webviewTagSetTransparent", {
			id: this.webviewId,
			transparent: this.transparent,
		});
	}

	togglePassthrough(value?: boolean) {
		if (this.webviewId === null) return;
		this.passthroughEnabled =
			value !== undefined ? value : !this.passthroughEnabled;
		this.style.pointerEvents = this.passthroughEnabled ? "none" : "";
		send("webviewTagSetPassthrough", {
			id: this.webviewId,
			enablePassthrough: this.passthroughEnabled,
		});
	}

	toggleHidden(value?: boolean) {
		if (this.webviewId === null) return;
		this.hidden = value !== undefined ? value : !this.hidden;
		send("webviewTagSetHidden", { id: this.webviewId, hidden: this.hidden });
	}

	// Mask management
	addMaskSelector(selector: string) {
		this.maskSelectors.add(selector);
		this.syncDimensions(true);
	}

	removeMaskSelector(selector: string) {
		this.maskSelectors.delete(selector);
		this.syncDimensions(true);
	}

	// Navigation rules
	setNavigationRules(rules: string[]) {
		if (this.webviewId !== null) {
			send("webviewTagSetNavigationRules", { id: this.webviewId, rules });
		}
	}

	// Find in page
	findInPage(
		searchText: string,
		options?: { forward?: boolean; matchCase?: boolean },
	) {
		if (this.webviewId === null) return;
		const forward = options?.forward !== false;
		const matchCase = options?.matchCase || false;
		send("webviewTagFindInPage", {
			id: this.webviewId,
			searchText,
			forward,
			matchCase,
		});
	}

	stopFindInPage() {
		if (this.webviewId !== null)
			send("webviewTagStopFind", { id: this.webviewId });
	}

	// DevTools
	openDevTools() {
		if (this.webviewId !== null)
			send("webviewTagOpenDevTools", { id: this.webviewId });
	}

	closeDevTools() {
		if (this.webviewId !== null)
			send("webviewTagCloseDevTools", { id: this.webviewId });
	}

	toggleDevTools() {
		if (this.webviewId !== null)
			send("webviewTagToggleDevTools", { id: this.webviewId });
	}

	// JavaScript execution
	executeJavascript(js: string) {
		if (this.webviewId === null) return;
		send("webviewTagExecuteJavascript", { id: this.webviewId, js });
	}

	// Event handling
	on(event: WebviewEventType, listener: (event: CustomEvent) => void) {
		if (!this._eventListeners[event]) this._eventListeners[event] = [];
		this._eventListeners[event].push(listener);
	}

	off(event: WebviewEventType, listener: (event: CustomEvent) => void) {
		if (!this._eventListeners[event]) return;
		const idx = this._eventListeners[event].indexOf(listener);
		if (idx !== -1) this._eventListeners[event].splice(idx, 1);
	}

	emit(event: WebviewEventType, detail: unknown) {
		const listeners = this._eventListeners[event];
		if (listeners) {
			const customEvent = new CustomEvent(event, { detail });
			listeners.forEach((fn) => fn(customEvent));
		}
	}

	// Property getters/setters
	get src(): string | null {
		return this.getAttribute("src");
	}
	set src(value: string | null) {
		if (value) {
			this.setAttribute("src", value);
			if (this.webviewId !== null) this.loadURL(value);
		} else {
			this.removeAttribute("src");
		}
	}

	get html(): string | null {
		return this.getAttribute("html");
	}
	set html(value: string | null) {
		if (value) {
			this.setAttribute("html", value);
			if (this.webviewId !== null) this.loadHTML(value);
		} else {
			this.removeAttribute("html");
		}
	}

	get preload(): string | null {
		return this.getAttribute("preload");
	}
	set preload(value: string | null) {
		if (value) this.setAttribute("preload", value);
		else this.removeAttribute("preload");
	}

	get renderer(): "native" | "cef" {
		return (this.getAttribute("renderer") as "native" | "cef") || "native";
	}
	set renderer(value: "native" | "cef") {
		this.setAttribute("renderer", value);
	}

	// Sandbox is read-only after creation (set via attribute before adding to DOM)
	get sandbox(): boolean {
		return this.sandboxed;
	}
}

export function initWebviewTag() {
	// Register the custom element if not already registered
	if (!customElements.get("electrobun-webview")) {
		customElements.define("electrobun-webview", ElectrobunWebviewTag);
	}

	// Add default styles for <electrobun-webview> elements
	// These can be easily overridden in the host document
	const injectStyles = () => {
		const style = document.createElement("style");
		style.textContent = `
electrobun-webview {
	display: block;
	width: 800px;
	height: 300px;
	background: #fff;
	background-repeat: no-repeat !important;
	overflow: hidden;
}
`;
		// Insert at the beginning of <head> so app styles take precedence
		if (document.head?.firstChild) {
			document.head.insertBefore(style, document.head.firstChild);
		} else if (document.head) {
			document.head.appendChild(style);
		}
	};

	// document.head may not exist at document start, defer if needed
	if (document.head) {
		injectStyles();
	} else {
		document.addEventListener("DOMContentLoaded", injectStyles);
	}
}
