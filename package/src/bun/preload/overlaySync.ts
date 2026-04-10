import "./globals.d.ts";

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type MaskRect = Rect;

export type OverlaySyncOptions = {
	onSync: (rect: Rect, masksJson: string) => void;
	getMasks?: () => MaskRect[];
	burstIntervalMs?: number;
	baseIntervalMs?: number;
	burstDurationMs?: number;
};

export class OverlaySyncController {
	private element: HTMLElement;
	private options: Required<OverlaySyncOptions>;
	private lastRect: Rect = { x: 0, y: 0, width: 0, height: 0 };
	private lastMasksJson = "[]";
	private resizeObserver: ResizeObserver | null = null;
	private positionLoop: ReturnType<typeof setTimeout> | null = null;
	private resizeHandler: (() => void) | null = null;
	private burstUntil = 0;

	constructor(element: HTMLElement, options: OverlaySyncOptions) {
		this.element = element;
		this.options = {
			onSync: options.onSync,
			getMasks: options.getMasks ?? (() => []),
			burstIntervalMs: options.burstIntervalMs ?? 50,
			baseIntervalMs: options.baseIntervalMs ?? 100,
			burstDurationMs: options.burstDurationMs ?? 500,
		};
	}

	start() {
		this.resizeObserver = new ResizeObserver(() => this.sync());
		this.resizeObserver.observe(this.element);

		const loop = () => {
			this.sync();
			const now = performance.now();
			const interval =
				now < this.burstUntil
					? this.options.burstIntervalMs
					: this.options.baseIntervalMs;
			this.positionLoop = setTimeout(loop, interval);
		};
		this.positionLoop = setTimeout(loop, this.options.baseIntervalMs);

		this.resizeHandler = () => this.sync(true);
		window.addEventListener("resize", this.resizeHandler);
	}

	stop() {
		if (this.resizeObserver) this.resizeObserver.disconnect();
		if (this.positionLoop) clearTimeout(this.positionLoop);
		if (this.resizeHandler) {
			window.removeEventListener("resize", this.resizeHandler);
		}
		this.resizeObserver = null;
		this.positionLoop = null;
		this.resizeHandler = null;
	}

	forceSync() {
		this.sync(true);
	}

	setLastRect(rect: Rect) {
		this.lastRect = rect;
	}

	private sync(force = false) {
		const rect = this.element.getBoundingClientRect();
		const newRect: Rect = {
			x: rect.x,
			y: rect.y,
			width: rect.width,
			height: rect.height,
		};

		if (newRect.width === 0 && newRect.height === 0) {
			return;
		}

		const rectChanged =
			newRect.x !== this.lastRect.x ||
			newRect.y !== this.lastRect.y ||
			newRect.width !== this.lastRect.width ||
			newRect.height !== this.lastRect.height;

		// Always recompute masks — a host popup can appear or move while the
		// webview is stationary, and we need to push the new mask list to the
		// native side even when the webview's own rect is unchanged.
		const masks = this.options.getMasks();
		const masksJson = JSON.stringify(masks);
		const masksChanged = masksJson !== this.lastMasksJson;

		if (!force && !rectChanged && !masksChanged) {
			return;
		}

		// Only enter a burst-poll window when the webview itself moved; a
		// mask-only change doesn't need the follow-up polling.
		if (rectChanged) {
			this.burstUntil = performance.now() + this.options.burstDurationMs;
		}
		this.lastRect = newRect;
		this.lastMasksJson = masksJson;

		this.options.onSync(newRect, masksJson);
	}
}
