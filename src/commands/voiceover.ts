import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { type CaptionCue, escapeForFfmpegSubtitlesFilter, formatSrt } from "./caption.js";
import { NarrateError, type Timings, validateTimings } from "./narrate.js";

/**
 * `lensmith voiceover` (CR-LENSMITH-A008-3) — places the narration lines (from
 * `lensmith narrate`) into a rendered film at the given start times and burns captions
 * built from the script's own cue times (no WhisperX, no listening to the audio again).
 */

export type CaptionMode = "burn" | "srt" | "none";

export interface VoiceoverOptions {
	video: string;
	narration: string;
	starts: string;
	out: string;
	captions?: string;
	srtOut?: string;
	json?: boolean;
}

export interface VoiceoverDeps {
	spawnSync: typeof spawnSync;
	log: (s: string) => void;
	error: (s: string) => void;
}

const realDeps: VoiceoverDeps = {
	spawnSync,
	log: (s) => console.log(s),
	error: (s) => console.error(s),
};

export class VoiceoverError extends Error {}

function readJsonFile<T>(file: string, label: string): T {
	if (!existsSync(file)) throw new VoiceoverError(`${label} not found: ${file}`);
	try {
		return JSON.parse(readFileSync(file, "utf-8")) as T;
	} catch (err) {
		throw new VoiceoverError(`${label} is not valid JSON: ${(err as Error).message}`);
	}
}

/** Cues from every placed line, shifted by that line's start (seconds), in time order. */
export function buildVoiceoverCues(timings: Timings, starts: Record<string, number>): CaptionCue[] {
	const cues: CaptionCue[] = [];
	for (const [id, startMs] of Object.entries(starts)) {
		for (const c of timings.lines[id]?.cues ?? []) {
			cues.push({
				start: (startMs + c.startMs) / 1000,
				end: (startMs + c.endMs) / 1000,
				text: c.text,
			});
		}
	}
	return cues.sort((a, b) => a.start - b.start);
}

/** Audio-only filtergraph: delay each line to its start, mix without normalizing, pad to the film length. */
export function buildAudioFilter(startsMs: number[], filmSeconds: number): string {
	const parts = startsMs.map((ms, i) => `[${i + 1}:a]adelay=${ms}|${ms}[a${i}]`);
	const labels = startsMs.map((_, i) => `[a${i}]`).join("");
	parts.push(
		`${labels}amix=inputs=${startsMs.length}:normalize=0:duration=longest,apad=whole_dur=${filmSeconds}[aout]`,
	);
	return parts.join(";");
}

export function buildFfmpegArgs(opts: {
	video: string;
	lineFiles: string[];
	startsMs: number[];
	filmSeconds: number;
	out: string;
	burnSrt?: string;
}): string[] {
	const args = ["-y", "-i", opts.video];
	for (const f of opts.lineFiles) args.push("-i", f);
	args.push("-filter_complex", buildAudioFilter(opts.startsMs, opts.filmSeconds));
	args.push("-map", "0:v:0", "-map", "[aout]");
	if (opts.burnSrt) {
		const style =
			"FontName=Arial,FontSize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=40";
		args.push(
			"-vf",
			`subtitles='${escapeForFfmpegSubtitlesFilter(opts.burnSrt)}':force_style='${style}'`,
			"-c:v",
			"libx264",
			"-crf",
			"18",
			"-pix_fmt",
			"yuv420p",
		);
	} else {
		args.push("-c:v", "copy");
	}
	args.push("-c:a", "aac", "-b:a", "192k", "-t", String(opts.filmSeconds), opts.out);
	return args;
}

function run(
	deps: VoiceoverDeps,
	cmd: string,
	args: string[],
	label: string,
): SpawnSyncReturns<string> {
	const r = deps.spawnSync(cmd, args, { encoding: "utf-8" });
	if (r.error) {
		const code = (r.error as NodeJS.ErrnoException).code;
		throw new VoiceoverError(
			code === "ENOENT"
				? `${label} not found on PATH ('${cmd}'). Install ffmpeg (e.g. 'brew install ffmpeg') first.`
				: `${label} failed to start: ${r.error.message}`,
		);
	}
	if (r.status !== 0) {
		const stderr = (r.stderr ?? "").toString().trim();
		throw new VoiceoverError(
			`${label} exited with code ${r.status}.${stderr ? `\n${stderr}` : ""}`,
		);
	}
	return r;
}

function hasSubtitlesFilter(deps: VoiceoverDeps): boolean {
	const r = deps.spawnSync("ffmpeg", ["-filters"], { encoding: "utf-8" });
	if (r.error || r.status !== 0) return false;
	return /^\s*\S*\s+subtitles\s/m.test((r.stdout ?? "").toString());
}

function probeSeconds(deps: VoiceoverDeps, file: string): number {
	const r = run(
		deps,
		"ffprobe",
		["-v", "error", "-show_entries", "format=duration", "-of", "json", file],
		"ffprobe",
	);
	const d = Number.parseFloat(
		(JSON.parse(r.stdout.toString()) as { format?: { duration?: string } }).format?.duration ?? "",
	);
	if (!Number.isFinite(d) || d <= 0)
		throw new VoiceoverError(`ffprobe found no duration for ${file}`);
	return d;
}

/** Runs `lensmith voiceover`. Returns a process exit code (0 = success). */
export function runVoiceover(opts: VoiceoverOptions, deps: VoiceoverDeps = realDeps): number {
	let tmpDir: string | undefined;
	try {
		const mode = (opts.captions ?? "burn") as CaptionMode;
		if (!["burn", "srt", "none"].includes(mode)) {
			throw new VoiceoverError(`--captions must be burn, srt or none (got '${opts.captions}')`);
		}
		if (!existsSync(opts.video)) throw new VoiceoverError(`video not found: ${opts.video}`);
		const timings = readJsonFile<Timings>(opts.narration, "narration timings");
		try {
			validateTimings(timings);
		} catch (err) {
			if (err instanceof NarrateError) throw new VoiceoverError(err.message);
			throw err;
		}
		const starts = readJsonFile<Record<string, number>>(opts.starts, "starts file");
		const ids = Object.keys(starts ?? {});
		if (!starts || typeof starts !== "object" || ids.length === 0) {
			throw new VoiceoverError('starts file needs at least one {"<id>": <ms>} entry');
		}
		const narrationDir = path.dirname(path.resolve(opts.narration));
		const lineFiles: string[] = [];
		for (const id of ids) {
			const line = timings.lines[id];
			if (!line)
				throw new VoiceoverError(`starts has line '${id}' which is not in the narration timings`);
			const ms = starts[id] as number;
			if (!Number.isFinite(ms) || ms < 0) {
				throw new VoiceoverError(`start for '${id}' must be a number of milliseconds >= 0`);
			}
			const file = path.resolve(narrationDir, line.file);
			if (!existsSync(file)) throw new VoiceoverError(`audio for line '${id}' not found: ${file}`);
			lineFiles.push(file);
		}

		const filmSeconds = probeSeconds(deps, opts.video);
		for (const id of ids) {
			const end = (starts[id] as number) + (timings.lines[id]?.durationMs ?? 0);
			if (end > filmSeconds * 1000) {
				throw new VoiceoverError(
					`line '${id}' would end at ${end} ms, beyond the film length (${Math.round(filmSeconds * 1000)} ms)`,
				);
			}
		}

		const cues = buildVoiceoverCues(timings, starts);
		const srt = formatSrt(cues);
		if (mode === "burn" && !hasSubtitlesFilter(deps)) {
			throw new VoiceoverError(
				"ffmpeg is on PATH but was built without the 'subtitles' filter (needs libass/freetype) — " +
					"captions cannot be burned in. On macOS install a full build (`brew install ffmpeg-full`), " +
					"or pass --captions srt|none.",
			);
		}
		let srtPath = opts.srtOut;
		if (mode === "srt" && !srtPath) srtPath = `${opts.out.replace(/\.[^./]+$/, "")}.srt`;
		if (srtPath) writeFileSync(srtPath, srt, "utf-8");

		let burnSrt: string | undefined;
		if (mode === "burn") {
			if (srtPath) burnSrt = srtPath;
			else {
				tmpDir = mkdtempSync(path.join(tmpdir(), "lensmith-voiceover-"));
				burnSrt = path.join(tmpDir, "captions.srt");
				writeFileSync(burnSrt, srt, "utf-8");
			}
		}

		run(
			deps,
			"ffmpeg",
			buildFfmpegArgs({
				video: opts.video,
				lineFiles,
				startsMs: ids.map((id) => starts[id] as number),
				filmSeconds,
				out: opts.out,
				burnSrt,
			}),
			"ffmpeg (voiceover mix)",
		);

		if (opts.json) {
			deps.log(
				JSON.stringify({
					ok: true,
					out: opts.out,
					lines: ids.length,
					cues: cues.length,
					captions: mode,
					srt: srtPath,
				}),
			);
		} else {
			deps.log(
				`Voiced film written: ${opts.out} (${ids.length} line${ids.length === 1 ? "" : "s"}, ${cues.length} caption cue${cues.length === 1 ? "" : "s"}, captions ${mode})`,
			);
		}
		return 0;
	} catch (err) {
		const message = (err as Error).message;
		if (opts.json) deps.log(JSON.stringify({ ok: false, error: message }));
		else deps.error(`Error: ${message}`);
		return 1;
	} finally {
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	}
}

export function registerVoiceoverCommand(program: Command): void {
	program
		.command("voiceover")
		.description(
			"Mix narration lines into a rendered film at given start times and burn script captions",
		)
		.requiredOption("--video <mp4>", "rendered film (from process)")
		.requiredOption("--narration <json>", "timings.json from narrate")
		.requiredOption("--starts <json>", 'JSON file {"<line id>": <ms from film start>}')
		.requiredOption("--out <mp4>", "output film path")
		.option("--captions <mode>", "burn (default), srt (write the SRT only) or none", "burn")
		.option("--srt-out <path>", "also write the SRT file")
		.option("--json", "print a machine-readable JSON result", false)
		.action((opts: VoiceoverOptions) => {
			const code = runVoiceover(opts);
			if (code !== 0) process.exitCode = code;
		});
}
