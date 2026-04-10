// Standalone preload build — avoids running the full build.ts pipeline
// (which downloads vendors, builds native wrappers, etc). Useful for fast
// iteration on the preload scripts.

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

async function buildPreload() {
	const packageDir = join(import.meta.dir, "..");
	const preloadDir = join(packageDir, "src", "bun", "preload");
	const outputDir = join(preloadDir, ".generated");
	const outputPath = join(outputDir, "compiled.ts");

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
// Run "bun build.ts" or "bun scripts/build-preload-only.ts" to regenerate.

// Full preload for trusted webviews (RPC, encryption, drag regions, webview tags)
export const preloadScript = ${JSON.stringify(fullPreloadJs)};

// Minimal preload for sandboxed/untrusted webviews (lifecycle events only, no RPC)
export const preloadScriptSandboxed = ${JSON.stringify(sandboxedPreloadJs)};
`;

	writeFileSync(outputPath, outputContent);
	console.log("Preload compiled ->", outputPath);
}

await buildPreload();
