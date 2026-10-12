import path from "node:path";
import type { Command } from "commander";
import {
	CURSOR_SHAPES_DEFAULT,
	type CursorShapes,
	parseCursorShapes,
} from "../lib/cursorShapes.js";
import { readJson, runHarness } from "../lib/harnessRunner.js";

interface EditorProjectDataLike {
	version: number;
	editor: unknown;
}

/**
 * `lensmith process` — renders and exports the final video from an
 * `EditorProjectData` project file (`--project`), hosting OpenScreen's
 * vendored `VideoExporter` (PixiJS + WebCodecs) inside a headless
 * Playwright/Chromium harness. See CR-LENSMITH-A001-4.
 */
export function registerProcessCommand(program: Command): void {
	program
		.command("process")
		.description("Render and export a project to a final MP4 video")
		.requiredOption("--project <path>", "EditorProjectData JSON (.openscreen project file)")
		.requiredOption("--raw <path>", "raw screen recording (.mp4)")
		.option(
			"--cursor <path>",
			"cursor telemetry JSON (.cursor.json) — omit to render without a cursor overlay",
		)
		.option(
			"--cursor-shapes <mode>",
			"cursor shape in the film: arrow (always the arrow) or native (the recorded shapes)",
			parseCursorShapes,
			CURSOR_SHAPES_DEFAULT,
		)
		.requiredOption("--out <path>", "output path for the rendered MP4")
		.action(
			async (opts: {
				project: string;
				raw: string;
				cursor?: string;
				cursorShapes: CursorShapes;
				out: string;
			}) => {
				const project = await readJson<EditorProjectDataLike>(opts.project, "--project file");
				const cursorRecordingData = opts.cursor
					? await readJson<unknown>(opts.cursor, "--cursor file")
					: null;

				console.log(`[lensmith process] rendering ${path.basename(opts.raw)} -> ${opts.out}`);

				const result = await runHarness({
					entryFn: "lensmithProcess",
					rawVideoPath: opts.raw,
					editor: project.editor,
					cursorRecordingData,
					cursorShapes: opts.cursorShapes,
					outPath: opts.out,
				});

				if (!result.success) {
					console.error(`[lensmith process] FAILED: ${result.error}`);
					process.exitCode = 1;
					return;
				}

				if (result.warnings?.length) {
					for (const w of result.warnings) console.warn(`[lensmith process] warning: ${w}`);
				}

				console.log(
					`[lensmith process] wrote ${opts.out} (${result.width}x${result.height}, ${result.bitrate} bps)`,
				);
			},
		);
}
