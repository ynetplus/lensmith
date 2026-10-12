#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Builds the headless render harness (CR-LENSMITH-A001-4):
 *   - esbuild-bundles src/harness/process.bootstrap.ts (which imports the
 *     vendored OpenScreen exporter under vendor/openscreen/) into
 *     dist/harness/process.bundle.js. SVGs (cursor icons) are inlined as
 *     data URIs so no separate asset-serving step is needed for them.
 *   - Copies src/harness/process.html next to the bundle.
 *   - Copies runtime assets the vendored code fetches by RELATIVE URL at
 *     run time (not via ESM import, so esbuild can't see them):
 *       - gif.js's web worker (gifExporter.ts resolves it via
 *         `new URL("gif.js/dist/gif.worker.js", import.meta.url)`)
 *       - web-demuxer's wasm binary (streamingDecoder.ts/audioEncoder.ts
 *         resolve it via `new URL("./wasm/web-demuxer.wasm", window.location.href)`)
 *       - the vendored wallpaper image(s) (wallpaper.ts builds
 *         `/wallpapers/wallpaperN.jpg` as an absolute path from page origin)
 *
 * This is a build step, not part of `tsc` — the vendored browser code uses
 * DOM/WebCodecs globals incompatible with the CLI's Node-targeted
 * tsconfig, so it is intentionally excluded from `tsc` (see
 * tsconfig.json's "exclude") and only ever type-erased/bundled by esbuild.
 */
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist", "harness");
const VENDOR_SRC = path.join(ROOT, "vendor", "openscreen", "src");

async function main() {
	await mkdir(OUT_DIR, { recursive: true });

	await esbuild.build({
		entryPoints: [path.join(ROOT, "src", "harness", "process.bootstrap.ts")],
		bundle: true,
		format: "esm",
		target: "chrome124",
		outfile: path.join(OUT_DIR, "process.bundle.js"),
		alias: { "@": VENDOR_SRC },
		loader: { ".svg": "dataurl" },
		logLevel: "info",
	});

	await cp(path.join(ROOT, "src", "harness", "process.html"), path.join(OUT_DIR, "process.html"));

	// gif.js worker — served at the exact relative path gifExporter.ts
	// resolves via `new URL("gif.js/dist/gif.worker.js", import.meta.url)`,
	// with import.meta.url being this bundle's own served URL.
	await mkdir(path.join(OUT_DIR, "gif.js", "dist"), { recursive: true });
	await cp(
		path.join(ROOT, "node_modules", "gif.js", "dist", "gif.worker.js"),
		path.join(OUT_DIR, "gif.js", "dist", "gif.worker.js"),
	);

	// web-demuxer wasm — served at the exact relative path
	// streamingDecoder.ts/audioEncoder.ts resolve via
	// `new URL("./wasm/web-demuxer.wasm", window.location.href)`, with
	// window.location.href being the harness page's own served URL (so
	// "./wasm/..." resolves relative to the harness directory, i.e. here).
	await mkdir(path.join(OUT_DIR, "wasm"), { recursive: true });
	await cp(
		path.join(ROOT, "node_modules", "web-demuxer", "dist", "wasm-files", "web-demuxer.wasm"),
		path.join(OUT_DIR, "wasm", "web-demuxer.wasm"),
	);

	// Vendored wallpaper(s) — resolved via getAssetPath() as an absolute
	// "/wallpapers/wallpaperN.jpg" path from the page origin.
	await cp(
		path.join(ROOT, "vendor", "openscreen", "public", "wallpapers"),
		path.join(OUT_DIR, "wallpapers"),
		{ recursive: true },
	);

	console.log(`[build-harness] wrote ${OUT_DIR}`);
}

main().catch((err) => {
	console.error("[build-harness] FAILED:", err);
	process.exit(1);
});
