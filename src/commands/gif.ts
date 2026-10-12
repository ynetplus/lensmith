import path from "node:path";
import type { Command } from "commander";
import { readJson, runHarness } from "../lib/harnessRunner.js";

interface EditorProjectDataLike {
	version: number;
	editor: unknown;
}

/**
 * `lensmith gif` — exports a GIF from a project, reusing the same headless
 * Playwright/Chromium harness as `lensmith process` (CR-LENSMITH-A001-4),
 * routed to OpenScreen's vendored `GifExporter` instead of `VideoExporter`.
 */
export function registerGifCommand(program: Command): void {
	program
		.command("gif")
		.description("Export a GIF from a project")
		.requiredOption("--project <path>", "EditorProjectData JSON (.openscreen project file)")
		.requiredOption("--raw <path>", "raw screen recording (.mp4)")
		.option(
			"--cursor <path>",
			"cursor telemetry JSON (.cursor.json) — omit to render without a cursor overlay",
		)
		.requiredOption("--out <path>", "output path for the rendered GIF")
		.action(async (opts: { project: string; raw: string; cursor?: string; out: string }) => {
			const project = await readJson<EditorProjectDataLike>(opts.project, "--project file");
			const cursorRecordingData = opts.cursor
				? await readJson<unknown>(opts.cursor, "--cursor file")
				: null;

			console.log(`[lensmith gif] rendering ${path.basename(opts.raw)} -> ${opts.out}`);

			const result = await runHarness({
				entryFn: "lensmithGif",
				rawVideoPath: opts.raw,
				editor: project.editor,
				cursorRecordingData,
				outPath: opts.out,
			});

			if (!result.success) {
				console.error(`[lensmith gif] FAILED: ${result.error}`);
				process.exitCode = 1;
				return;
			}

			if (result.warnings?.length) {
				for (const w of result.warnings) console.warn(`[lensmith gif] warning: ${w}`);
			}

			console.log(`[lensmith gif] wrote ${opts.out} (${result.width}x${result.height})`);
		});
}
