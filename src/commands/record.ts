import { Command, InvalidOptionArgumentError } from "commander";
import { assertValidSourceSyntax, InvalidSourceError } from "../lib/recordingRequest.js";
import { runRecord } from "../lib/recordSession.js";

function parseFps(value: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new InvalidOptionArgumentError("--fps must be a positive integer.");
	}
	return parsed;
}

/**
 * Validates `--source`'s shape at commander's own argument-parsing time — i.e. before the
 * `action` callback runs, so before `runRecord` resolves or spawns any native helper binary.
 * Mirrors `parseFps` above: commander calls this coercion function while parsing argv, and a
 * thrown `InvalidOptionArgumentError` becomes a clean commander-formatted rejection instead of
 * a crash. (Bugfix riding along with CR-LENSMITH-A001-4 — `tests/cli.test.ts` expected this
 * order; previously `record`'s action checked for the compiled native helper binaries before
 * validating `--source`, so a malformed `--source` on a clean checkout with no native build
 * surfaced "Native helper ... not found" instead of the actual argument error.)
 */
function parseSource(value: string): string {
	try {
		assertValidSourceSyntax(value);
	} catch (error) {
		if (error instanceof InvalidSourceError) {
			throw new InvalidOptionArgumentError(error.message);
		}
		throw error;
	}
	return value;
}

/**
 * `lensmith record` — native macOS screen + audio capture with cursor
 * telemetry, built on OpenScreen's standalone ScreenCaptureKit Swift
 * helpers (vendored in `src/native/screencapturekit/`, see NOTICE.md) plus
 * Lensmith's own cursor-position helper (`src/native/lensmith-helpers/`).
 * CR-LENSMITH-A001-2.
 */
export function registerRecordCommand(program: Command): void {
	program
		.command("record")
		.description("Record the screen with cursor telemetry (ScreenCaptureKit, macOS only)")
		.option("--source <source>", "screen, window:<id> or region:x,y,w,h", parseSource, "screen")
		.option("--fps <n>", "frames per second", parseFps, 60)
		.option("--mic", "capture microphone audio", false)
		.option("--system-audio", "capture system audio", false)
		.option("--out <path>", "output video path (default: recording-<epoch-ms>.mp4)")
		.action(
			async (opts: {
				source: string;
				fps: number;
				mic: boolean;
				systemAudio: boolean;
				out?: string;
			}) => {
				const startTimeMs = Date.now();
				const out = opts.out ?? `recording-${startTimeMs}.mp4`;
				const exitCode = await runRecord(
					{
						source: opts.source,
						fps: opts.fps,
						mic: opts.mic,
						systemAudio: opts.systemAudio,
						out,
					},
					{ startTimeMs },
				);
				process.exitCode = exitCode;
			},
		);
}
