// Prepare the fork's dist/ folder for packaging.
//
// Builds a minimal, self-contained distribution that's enough to ship via a
// GitHub release tarball and consume from another project (Tempest). Does NOT
// rebuild the native wrapper, the CLI, or the Zig launcher — those either come
// from upstream binaries or aren't needed for the tarball distribution path.
//
// Produces:
//   dist/main.js                         (from src/launcher/main.ts)
//   dist/api/bun/                         (copy of src/bun/)
//   dist/api/browser/                     (copy of src/browser/)
//   dist/api/shared/                      (copy of src/shared/)
//   dist/api/bun/preload/.generated/compiled.ts  (built preload script)
//
// Run from the package directory:
//   bun scripts/prepare-dist.ts

import { $ } from "bun";
import { join } from "path";
import { existsSync, mkdirSync, rmSync } from "fs";

const PACKAGE_DIR = join(import.meta.dir, "..");
process.chdir(PACKAGE_DIR);

async function buildPreload() {
	const preloadDir = join("src", "bun", "preload");
	const outputDir = join(preloadDir, ".generated");
	mkdirSync(outputDir, { recursive: true });

	const fullResult = await Bun.build({
		entrypoints: [join(preloadDir, "index.ts")],
		target: "browser",
		format: "esm",
		minify: false,
	});
	if (!fullResult.success) {
		console.error("Full preload build failed:", fullResult.logs);
		process.exit(1);
	}

	const sandboxedResult = await Bun.build({
		entrypoints: [join(preloadDir, "index-sandboxed.ts")],
		target: "browser",
		format: "esm",
		minify: false,
	});
	if (!sandboxedResult.success) {
		console.error("Sandboxed preload build failed:", sandboxedResult.logs);
		process.exit(1);
	}

	const fullPreloadJs = `(function(){${await fullResult.outputs[0]!.text()}})();`;
	const sandboxedPreloadJs = `(function(){${await sandboxedResult.outputs[0]!.text()}})();`;

	const outputContent = `// Auto-generated file. Do not edit directly.
// Run "bun scripts/prepare-dist.ts" (or the full build.ts) to regenerate.

// Full preload for trusted webviews (RPC, encryption, drag regions, webview tags)
export const preloadScript = ${JSON.stringify(fullPreloadJs)};

// Minimal preload for sandboxed/untrusted webviews (lifecycle events only, no RPC)
export const preloadScriptSandboxed = ${JSON.stringify(sandboxedPreloadJs)};
`;

	await Bun.write(join(outputDir, "compiled.ts"), outputContent);
	console.log("  preload compiled");
}

async function buildMainJs() {
	const result = await Bun.build({
		entrypoints: [join("src", "launcher", "main.ts")],
		outdir: "dist",
		external: [],
		target: "bun",
	});
	if (!result.success) {
		console.error("main.js build failed:", result.logs);
		process.exit(1);
	}
	if (!existsSync(join("dist", "main.js"))) {
		console.error("main.js was not produced at dist/main.js");
		process.exit(1);
	}
	console.log("  main.js built");
}

async function copyApiFiles() {
	// Wipe any stale copies first so we don't mix files from prior runs.
	for (const sub of ["bun", "browser", "shared"]) {
		const target = join("dist", "api", sub);
		if (existsSync(target)) rmSync(target, { recursive: true, force: true });
	}
	mkdirSync(join("dist", "api"), { recursive: true });
	// `cp -R src/bun dist/api/` copies the bun dir INTO dist/api.
	await $`cp -R src/bun dist/api/`;
	await $`cp -R src/browser dist/api/`;
	await $`cp -R src/shared dist/api/`;
	console.log("  api files copied");
}

console.log("Preparing dist/...");
await buildPreload();
await copyApiFiles();
await buildMainJs();
console.log("dist/ is ready at:", join(PACKAGE_DIR, "dist"));
