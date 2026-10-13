import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Command } from "commander";

/**
 * `lensmith caption` — generates word-level captions via WhisperX and
 * burns them into the video via ffmpeg.
 *
 * Deliberately does NOT reuse OpenScreen's in-browser Whisper-WASM
 * captioning code (`src/lib/captioning/*` upstream) — see
 * CR-LENSMITH-A001-5 Scope. This file uses the standard WhisperX CLI
 * invocation shape (`whisperx <audio> --model ... --output_format
 * json ...`) as a disclosed judgment call, not an invented one-off API.
 */

export interface WhisperWord {
	word: string;
	start?: number;
	end?: number;
	score?: number;
}

export interface WhisperSegment {
	start: number;
	end: number;
	text: string;
	words?: WhisperWord[];
}

export interface WhisperXResult {
	segments: WhisperSegment[];
}

export interface CaptionCue {
	start: number;
	end: number;
	text: string;
}

const WHISPERX_MODEL = process.env.LENSMITH_WHISPERX_MODEL ?? "small";
const WHISPERX_DEVICE = process.env.LENSMITH_WHISPERX_DEVICE ?? "cpu";
const WHISPERX_COMPUTE_TYPE = process.env.LENSMITH_WHISPERX_COMPUTE_TYPE ?? "int8";
const MAX_WORDS_PER_CUE = 7;
const MAX_CUE_DURATION_S = 4;
const MAX_WORD_GAP_S = 1;

export interface CaptionOptions {
	in: string;
	out: string;
	burnIn: boolean;
	srtOut?: string;
}

/** Injectable subset of node APIs so the orchestration is unit-testable without real binaries. */
export interface CaptionDeps {
	spawnSync: typeof spawnSync;
}

const realDeps: CaptionDeps = { spawnSync };

export function registerCaptionCommand(program: Command): void {
	program
		.command("caption")
		.description("Generate word-level captions for a recording via WhisperX")
		.requiredOption("--in <video>", "input video file")
		.requiredOption("--out <video>", "output video path (captioned, unless --no-burn-in)")
		.option("--no-burn-in", "skip burning captions into the video — only write --srt-out")
		.option("--srt-out <path>", "also write the raw SRT subtitle file")
		.action((opts: { in: string; out: string; burnIn: boolean; srtOut?: string }) => {
			const exitCode = runCaption(
				{ in: opts.in, out: opts.out, burnIn: opts.burnIn, srtOut: opts.srtOut },
				realDeps,
			);
			if (exitCode !== 0) {
				process.exitCode = exitCode;
			}
		});
}

/** Formats seconds as an SRT timestamp: HH:MM:SS,mmm */
export function formatSrtTimestamp(seconds: number): string {
	const clamped = Math.max(0, seconds);
	const totalMs = Math.round(clamped * 1000);
	const ms = totalMs % 1000;
	const totalSeconds = Math.floor(totalMs / 1000);
	const s = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const m = totalMinutes % 60;
	const h = Math.floor(totalMinutes / 60);
	const pad2 = (n: number) => n.toString().padStart(2, "0");
	const pad3 = (n: number) => n.toString().padStart(3, "0");
	return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`;
}

/**
 * Groups WhisperX's word-level timestamps into readable caption cues
 * (a few words at a time, tightly synced from actual word boundaries
 * rather than Whisper's coarser segment-level VAD boundaries), splitting
 * on word count, duration, and natural pauses between words.
 */
export function buildCaptionCues(result: WhisperXResult): CaptionCue[] {
	const cues: CaptionCue[] = [];

	for (const segment of result.segments ?? []) {
		const words = (segment.words ?? []).filter((w) => typeof w.word === "string" && w.word.trim());

		if (words.length === 0) {
			if (segment.text?.trim()) {
				cues.push({ start: segment.start, end: segment.end, text: segment.text.trim() });
			}
			continue;
		}

		let bucket: WhisperWord[] = [];
		let bucketStart = 0;

		const flush = () => {
			if (bucket.length === 0) return;
			const start = bucket[0]?.start ?? bucketStart;
			const end = bucket[bucket.length - 1]?.end ?? start;
			const text = bucket
				.map((w) => w.word.trim())
				.join(" ")
				.replace(/\s+([.,!?;:])/g, "$1")
				.trim();
			if (text) cues.push({ start, end, text });
			bucket = [];
		};

		for (const word of words) {
			const wStart = word.start ?? segment.start;
			const wEnd = word.end ?? wStart;

			if (bucket.length === 0) {
				bucketStart = wStart;
				bucket.push(word);
				continue;
			}

			const prevEnd = bucket[bucket.length - 1]?.end ?? bucketStart;
			const gap = wStart - prevEnd;
			const duration = wEnd - bucketStart;

			if (
				bucket.length >= MAX_WORDS_PER_CUE ||
				duration > MAX_CUE_DURATION_S ||
				gap > MAX_WORD_GAP_S
			) {
				flush();
				bucketStart = wStart;
			}
			bucket.push(word);
		}
		flush();
	}

	return cues;
}

/** Renders caption cues as a well-formed SRT document. */
export function formatSrt(cues: CaptionCue[]): string {
	return cues
		.map((cue, i) => {
			const index = i + 1;
			const start = formatSrtTimestamp(cue.start);
			const end = formatSrtTimestamp(Math.max(cue.end, cue.start + 0.01));
			return `${index}\n${start} --> ${end}\n${cue.text}\n`;
		})
		.join("\n");
}

/**
 * The one burned-caption look, shared by `caption` and `voiceover`: white
 * medium-weight Helvetica Neue on a translucent dark bar (rgba 14,16,22 at
 * 74 %), no outline, no shadow, centred in the bottom safe zone. libass sizes
 * an SRT in a 384x288 script space scaled to the video height, so the same
 * constant serves every frame size (at 1080p one unit is 3.75 px).
 * `BorderStyle=4` draws one box behind the event with `Outline` as its padding;
 * libass still strokes the glyph outline in that mode, so `OutlineColour` is
 * fully transparent (alpha FF) and `MarginV` includes the padding (bar bottom
 * 64 px above the frame bottom at 1080p).
 * libass fits a font's ascent+descent to `FontSize`, so 18 units give a
 * ~40 px cap height at 1080p.
 * `Bold=500` is a numeric weight to libass (any value above 1 is), which is
 * how it selects the Medium face; the font name alone resolves Regular.
 */
export const CAPTION_STYLE =
	"FontName=Helvetica Neue,FontSize=18,Bold=500,PrimaryColour=&H00FFFFFF,BackColour=&H4216100E,OutlineColour=&HFF16100E,BorderStyle=4,Outline=4,Shadow=0,Alignment=2,MarginV=21,MarginL=54,MarginR=54,WrapStyle=0";

/** Escapes a filesystem path for safe use inside ffmpeg's `subtitles=` filter argument. */
export function escapeForFfmpegSubtitlesFilter(filePath: string): string {
	// ffmpeg's filtergraph parser treats `:`, `\`, and `'` specially inside a
	// filter option value; escape them so absolute paths (which may contain
	// `:` on some platforms) survive intact.
	return filePath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function commandAvailable(deps: CaptionDeps, cmd: string): boolean {
	const result = deps.spawnSync(cmd, ["-version"], { stdio: "ignore" });
	return !result.error;
}

/**
 * Some ffmpeg builds — notably Homebrew's default `ffmpeg` formula on
 * macOS — ship WITHOUT libass/freetype, so neither the `subtitles` nor
 * `drawtext` filter exists at all (confirmed by hand: stock `brew install
 * ffmpeg` 8.1 has neither; `brew install ffmpeg-full` has both). Without
 * this check, --burn-in would fail deep inside a real transcription run
 * with a cryptic ffmpeg filtergraph parser error ("No option name near
 * ..."). Check early — before spending time on WhisperX — and fail with
 * an actionable message instead.
 */
function ffmpegHasSubtitlesFilter(deps: CaptionDeps): boolean {
	const result = deps.spawnSync("ffmpeg", ["-filters"], { encoding: "utf-8" });
	if (result.error || result.status !== 0) return false;
	return /^\s*\S*\s+subtitles\s/m.test(result.stdout ?? "");
}

function runOrThrow(
	deps: CaptionDeps,
	cmd: string,
	args: string[],
	label: string,
): SpawnSyncReturns<Buffer> {
	const result = deps.spawnSync(cmd, args, { encoding: "buffer" });
	if (result.error) {
		const code = (result.error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new CaptionError(
				`${label} not found on PATH ('${cmd}'). Install it (e.g. 'brew install ffmpeg' or 'pip install whisperx') and make sure it is on PATH before running 'lensmith caption'.`,
			);
		}
		throw new CaptionError(`${label} failed to start: ${result.error.message}`);
	}
	if (result.status !== 0) {
		const stderr = result.stderr?.toString("utf-8").trim();
		throw new CaptionError(
			`${label} exited with code ${result.status}.${stderr ? `\n${stderr}` : ""}`,
		);
	}
	return result;
}

export class CaptionError extends Error {}

/**
 * Runs the full caption pipeline. Returns a process exit code (0 = success).
 * Exported for direct unit testing (see tests/caption.test.ts) — the CLI
 * `action` handler above is a thin wrapper around this.
 */
export function runCaption(opts: CaptionOptions, deps: CaptionDeps = realDeps): number {
	if (!existsSync(opts.in)) {
		console.error(`Error: input video not found: ${opts.in}`);
		return 1;
	}

	let tmpDir: string | undefined;
	try {
		if (!commandAvailable(deps, "ffmpeg")) {
			throw new CaptionError(
				"ffmpeg not found on PATH. Install ffmpeg (e.g. 'brew install ffmpeg') and make sure it is on PATH before running 'lensmith caption'.",
			);
		}
		if (opts.burnIn && !ffmpegHasSubtitlesFilter(deps)) {
			throw new CaptionError(
				"ffmpeg is on PATH but was built without the 'subtitles' filter (needs libass/freetype) — " +
					"--burn-in cannot composite captions onto the video. On macOS, the default `brew install " +
					"ffmpeg` formula lacks this; install a full build instead (`brew install ffmpeg-full`), " +
					"or pass --no-burn-in to only write --srt-out.",
			);
		}

		tmpDir = mkdtempSync(path.join(tmpdir(), "lensmith-caption-"));
		const audioPath = path.join(tmpDir, "audio.wav");

		// 1. Extract audio: mono, 16kHz PCM — the standard input format for
		// Whisper-family models.
		runOrThrow(
			deps,
			"ffmpeg",
			["-y", "-i", opts.in, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath],
			"ffmpeg (audio extraction)",
		);

		// 2. Run WhisperX for word-level timestamps.
		runOrThrow(
			deps,
			"whisperx",
			[
				audioPath,
				"--model",
				WHISPERX_MODEL,
				"--device",
				WHISPERX_DEVICE,
				"--compute_type",
				WHISPERX_COMPUTE_TYPE,
				"--language",
				"en",
				"--output_format",
				"json",
				"--output_dir",
				tmpDir,
			],
			"WhisperX",
		);

		const jsonPath = path.join(tmpDir, "audio.json");
		if (!existsSync(jsonPath)) {
			throw new CaptionError(
				`WhisperX ran but produced no output at ${jsonPath} — treating as a failure rather than a silent empty-caption pass.`,
			);
		}
		const result = JSON.parse(readFileSync(jsonPath, "utf-8")) as WhisperXResult;
		const cues = buildCaptionCues(result);

		// 3. Write the raw SRT (well-formed even when cues is empty — a
		// silent/near-silent input is not an error).
		const srt = formatSrt(cues);
		if (opts.srtOut) {
			writeFileSync(opts.srtOut, srt, "utf-8");
			console.log(
				`SRT written: ${opts.srtOut} (${cues.length} cue${cues.length === 1 ? "" : "s"})`,
			);
		}

		// 4. Burn in — only if requested AND there's something to burn.
		// A silent input produces zero cues, so --out is just the
		// unchanged input, same as the --no-burn-in path.
		if (opts.burnIn && cues.length > 0) {
			const srtForBurn = opts.srtOut ?? path.join(tmpDir, "captions.srt");
			if (!opts.srtOut) writeFileSync(srtForBurn, srt, "utf-8");

			const filter = `subtitles='${escapeForFfmpegSubtitlesFilter(srtForBurn)}':force_style='${CAPTION_STYLE}'`;
			runOrThrow(
				deps,
				"ffmpeg",
				["-y", "-i", opts.in, "-vf", filter, "-c:a", "copy", opts.out],
				"ffmpeg (caption burn-in)",
			);
			console.log(`Captioned video written: ${opts.out} (${cues.length} cues burned in)`);
		} else {
			copyFileSync(opts.in, opts.out);
			if (opts.burnIn && cues.length === 0) {
				console.log(`No speech detected — ${opts.out} is an unchanged copy of the input.`);
			} else {
				console.log(`--no-burn-in: ${opts.out} is an unchanged copy of the input.`);
			}
		}

		return 0;
	} catch (err) {
		const message = err instanceof CaptionError ? err.message : (err as Error).message;
		console.error(`Error: ${message}`);
		return 1;
	} finally {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}
}
