import type { SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CAPTION_STYLE } from "../src/commands/caption.js";
import { buildVoiceoverCues, runVoiceover, type VoiceoverDeps } from "../src/commands/voiceover.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const timings = {
	lines: {
		l1: {
			file: "l1.wav",
			durationMs: 3000,
			marks: {},
			words: [{ text: "Hello", startMs: 200, endMs: 800 }],
			cues: [{ startMs: 200, endMs: 2800, text: "Hello there." }],
		},
		l2: {
			file: "l2.wav",
			durationMs: 2000,
			marks: {},
			words: [{ text: "Bye", startMs: 100, endMs: 500 }],
			cues: [{ startMs: 100, endMs: 1900, text: "Bye now." }],
		},
	},
};

function setup(starts: Record<string, number>, filmSeconds = 10, hasSubs = true) {
	const dir = mkdtempSync(path.join(tmpdir(), "vo-test-"));
	dirs.push(dir);
	writeFileSync(path.join(dir, "film.mp4"), "x");
	writeFileSync(path.join(dir, "l1.wav"), "x");
	writeFileSync(path.join(dir, "l2.wav"), "x");
	writeFileSync(path.join(dir, "timings.json"), JSON.stringify(timings));
	writeFileSync(path.join(dir, "starts.json"), JSON.stringify(starts));
	const calls: { cmd: string; args: string[] }[] = [];
	const out: string[] = [];
	const errs: string[] = [];
	const deps: VoiceoverDeps = {
		spawnSync: ((cmd: string, args: string[]) => {
			calls.push({ cmd, args });
			let stdout = "";
			if (cmd === "ffprobe") stdout = JSON.stringify({ format: { duration: String(filmSeconds) } });
			if (cmd === "ffmpeg" && args[0] === "-filters")
				stdout = hasSubs ? " T. subtitles V->V\n" : " T. scale V->V\n";
			return { status: 0, stdout, stderr: "" } as SpawnSyncReturns<string>;
		}) as unknown as VoiceoverDeps["spawnSync"],
		log: (s) => out.push(s),
		error: (s) => errs.push(s),
	};
	const opts = {
		video: path.join(dir, "film.mp4"),
		narration: path.join(dir, "timings.json"),
		starts: path.join(dir, "starts.json"),
		out: path.join(dir, "out.mp4"),
	};
	const mix = () => calls.find((c) => c.cmd === "ffmpeg" && c.args[0] === "-y");
	return { dir, opts, deps, calls, out, errs, mix };
}

describe("voiceover", () => {
	it("places each line with adelay and mixes with amix normalize=0", () => {
		const t = setup({ l1: 1000, l2: 6000 });
		expect(runVoiceover(t.opts, t.deps)).toBe(0);
		const args = t.mix()?.args ?? [];
		const fc = args[args.indexOf("-filter_complex") + 1] as string;
		expect(fc).toContain("[1:a]adelay=1000|1000[a0]");
		expect(fc).toContain("[2:a]adelay=6000|6000[a1]");
		expect(fc).toContain("amix=inputs=2:normalize=0");
		expect(fc).toContain("apad=whole_dur=10");
		expect(args).toContain("aac");
		expect(args).toContain("192k");
	});

	it("burn mode re-encodes video with the subtitles filter", () => {
		const t = setup({ l1: 1000, l2: 6000 });
		runVoiceover(t.opts, t.deps);
		const args = t.mix()?.args ?? [];
		expect(args[args.indexOf("-vf") + 1]).toContain("subtitles=");
		expect(args).toContain("libx264");
	});

	it("burn mode uses the shared CAPTION_STYLE", () => {
		const t = setup({ l1: 1000, l2: 6000 });
		runVoiceover(t.opts, t.deps);
		const args = t.mix()?.args ?? [];
		expect(args[args.indexOf("-vf") + 1]).toContain(`force_style='${CAPTION_STYLE}'`);
	});

	it("copies the video stream with --captions none and srt", () => {
		for (const mode of ["none", "srt"]) {
			const t = setup({ l1: 1000 });
			expect(runVoiceover({ ...t.opts, captions: mode }, t.deps)).toBe(0);
			const args = t.mix()?.args ?? [];
			expect(args[args.indexOf("-c:v") + 1]).toBe("copy");
			expect(args).not.toContain("-vf");
		}
	});

	it("shifts cues by each line start and writes SRT", () => {
		const cues = buildVoiceoverCues(timings, { l1: 1000, l2: 6000 });
		expect(cues).toEqual([
			{ start: 1.2, end: 3.8, text: "Hello there." },
			{ start: 6.1, end: 7.9, text: "Bye now." },
		]);
		const t = setup({ l1: 1000, l2: 6000 });
		const srtOut = path.join(t.dir, "c.srt");
		runVoiceover({ ...t.opts, captions: "srt", srtOut }, t.deps);
		const srt = readFileSync(srtOut, "utf-8");
		expect(srt).toContain("00:00:01,200 --> 00:00:03,800\nHello there.");
		expect(srt).toContain("00:00:06,100 --> 00:00:07,900\nBye now.");
	});

	it("rejects a start beyond the film length", () => {
		const t = setup({ l1: 1000, l2: 9000 }, 10);
		expect(runVoiceover(t.opts, t.deps)).toBe(1);
		expect(t.errs.join()).toContain("beyond the film length");
		expect(t.mix()).toBeUndefined();
	});

	it("rejects an unknown line id", () => {
		const t = setup({ nope: 1000 });
		expect(runVoiceover(t.opts, t.deps)).toBe(1);
		expect(t.errs.join()).toContain("not in the narration timings");
	});

	it("fails clearly when ffmpeg lacks the subtitles filter", () => {
		const t = setup({ l1: 1000 }, 10, false);
		expect(runVoiceover(t.opts, t.deps)).toBe(1);
		expect(t.errs.join()).toContain("subtitles");
	});
});
