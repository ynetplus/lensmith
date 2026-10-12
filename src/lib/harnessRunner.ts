/**
 * Node-side driver for the headless Playwright render harness
 * (CR-LENSMITH-A001-4). Shared by `lensmith process` and `lensmith gif`
 * (src/commands/process.ts, src/commands/gif.ts) — both host the same
 * vendored OpenScreen exporter code, just calling a different entry point.
 *
 * No real HTTP server is involved: every request the harness page makes
 * (navigation, the raw video fetch, the exported-bytes upload) is
 * intercepted via Playwright's page.route() under a fake origin and
 * fulfilled from local disk / an in-memory buffer. This avoids managing a
 * port (and its failure modes) entirely — see the forge report for why
 * this was chosen over a real static file server.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = path.join(__dirname, "..", "..", "dist", "harness");
const FAKE_ORIGIN = "https://lensmith.harness";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript",
	".mjs": "application/javascript",
	".wasm": "application/wasm",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".mp4": "video/mp4",
};

export interface HarnessRunOptions {
	/** Which window.* entry point the harness bootstrap exposes to call. */
	entryFn: "lensmithProcess" | "lensmithGif";
	rawVideoPath: string;
	/** EditorProjectData.editor, parsed straight from the --project file. */
	editor: unknown;
	/** Parsed --cursor telemetry JSON, or null if --cursor was omitted. */
	cursorRecordingData: unknown | null;
	/** CR-LENSMITH-A007-11: arrow (default) or native recorded shapes. */
	cursorShapes?: "arrow" | "native";
	outPath: string;
}

export interface HarnessRunResult {
	success: boolean;
	error?: string;
	warnings?: string[];
	width?: number;
	height?: number;
	bitrate?: number;
}

/** Chromium flags that route WebGL to Metal on macOS (CR-LENSMITH-A007-1). */
const GPU_ARGS = ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"];

/**
 * Chromium launch options. On macOS the GPU flags are added unless
 * LENSMITH_RENDER_GPU=0; every other platform launches exactly as before.
 */
export function buildLaunchOptions(
	platform: string = process.platform,
	env: Record<string, string | undefined> = process.env,
): { headless: true; args?: string[] } {
	if (platform !== "darwin" || env.LENSMITH_RENDER_GPU === "0") return { headless: true };
	return { headless: true, args: [...GPU_ARGS] };
}

/** Classifies a WEBGL_debug_renderer_info renderer string. */
export function classifyRenderer(
	renderer: string | null | undefined,
): "gpu" | "software" | "unknown" {
	if (!renderer) return "unknown";
	return /swiftshader/i.test(renderer) ? "software" : "gpu";
}

/** One stderr line describing the active renderer, or null when unknown. */
export function rendererLine(renderer: string | null | undefined): string | null {
	const kind = classifyRenderer(renderer);
	if (kind === "software") {
		return "lensmith: render GPU unavailable, using software rendering (slower)";
	}
	return kind === "gpu" ? `lensmith: render GPU: ${renderer}` : null;
}

/**
 * Launches headless Chromium, hosts the harness page under a fake origin
 * (page.route() intercepts everything — no real network, no port), calls
 * the requested export entry point, and writes the resulting bytes to
 * `outPath` on success.
 */
export async function runHarness(opts: HarnessRunOptions): Promise<HarnessRunResult> {
	const browser = await chromium.launch(buildLaunchOptions());
	let uploadedBytes: Buffer | null = null;

	try {
		const page = await browser.newPage();

		page.on("console", (msg) => {
			if (msg.type() === "error" || msg.type() === "warning" || msg.type() === "log") {
				process.stderr.write(`[harness:${msg.type()}] ${msg.text()}\n`);
			}
		});
		page.on("pageerror", (err) => {
			process.stderr.write(`[harness:pageerror] ${err.stack ?? err.message}\n`);
		});

		await page.route(`${FAKE_ORIGIN}/**`, async (route) => {
			const request = route.request();
			const url = new URL(request.url());

			if (url.pathname === "/upload" && request.method() === "POST") {
				uploadedBytes = request.postDataBuffer();
				await route.fulfill({ status: 200, body: "ok" });
				return;
			}

			if (url.pathname === "/input.mp4") {
				try {
					const body = await readFile(opts.rawVideoPath);
					await route.fulfill({ status: 200, contentType: "video/mp4", body });
				} catch (e) {
					await route.fulfill({ status: 404, body: `raw video not found: ${String(e)}` });
				}
				return;
			}

			const rel = url.pathname === "/" ? "/process.html" : url.pathname;
			const filePath = path.join(HARNESS_DIR, rel);
			try {
				const body = await readFile(filePath);
				const ext = path.extname(filePath);
				await route.fulfill({
					status: 200,
					contentType: MIME[ext] ?? "application/octet-stream",
					body,
				});
			} catch {
				await route.fulfill({ status: 404, body: `not found: ${rel}` });
			}
		});

		await page.goto(`${FAKE_ORIGIN}/process.html`);
		await page.waitForFunction("window.__lensmithHarnessReady === true", undefined, {
			timeout: 15_000,
		});

		try {
			// Probe only; a failure here must never fail the render.
			// Runs in the page; the CLI tsconfig has no DOM lib, hence the string form.
			const renderer = (await page.evaluate(`(() => {
				const gl = document.createElement("canvas").getContext("webgl");
				const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
				return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : null;
			})()`)) as string | null;
			const line = rendererLine(renderer);
			if (line) process.stderr.write(`${line}\n`);
		} catch {
			// ignore
		}

		const result = (await page.evaluate(
			// globalThis (not window) — this callback is type-checked against the
			// CLI's Node-only tsconfig even though it actually runs in the page.
			({ fn, input }) => {
				// biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch to a window global set by process.bootstrap.ts
				return (globalThis as any)[fn](input);
			},
			{
				fn: opts.entryFn,
				input: {
					editor: opts.editor,
					videoUrl: `${FAKE_ORIGIN}/input.mp4`,
					cursorRecordingData: opts.cursorRecordingData,
					cursorShapes: opts.cursorShapes,
					outputUploadUrl: `${FAKE_ORIGIN}/upload`,
				},
			},
		)) as HarnessRunResult;

		if (result.success) {
			if (!uploadedBytes) {
				return {
					success: false,
					error: "harness reported success but no output bytes were uploaded",
				};
			}
			await writeFile(opts.outPath, uploadedBytes);
		}

		return result;
	} finally {
		await browser.close();
	}
}

/** Reads and JSON-parses a file, with a CLI-friendly error on failure. */
export async function readJson<T>(filePath: string, label: string): Promise<T> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf-8");
	} catch (e) {
		throw new Error(
			`Failed to read ${label} at ${filePath}: ${e instanceof Error ? e.message : e}`,
		);
	}
	try {
		return JSON.parse(raw) as T;
	} catch (e) {
		throw new Error(
			`Failed to parse ${label} at ${filePath} as JSON: ${e instanceof Error ? e.message : e}`,
		);
	}
}
