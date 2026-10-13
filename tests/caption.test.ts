import type { SpawnSyncReturns } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildCaptionCues,
	CAPTION_STYLE,
	type CaptionDeps,
	escapeForFfmpegSubtitlesFilter,
	formatSrt,
	formatSrtTimestamp,
	runCaption,
	type WhisperXResult,
} from "../src/commands/caption.js";

// These tests drive `runCaption` directly (not the built CLI) with a
// FAKE `spawnSync` injected via `CaptionDeps` — no real ffmpeg/WhisperX
// binaries are invoked. This is deliberate: WhisperX is a heavy Python/ML
// dependency that is not installed in CI (ubuntu-latest has no ML stack
// preinstalled) and was not installed in this build environment either
// (see the forge report for the disclosed judgment call). The fake
// simulates each binary's observable contract — exit code, stderr on
// failure, and (for WhisperX) the JSON file it writes to --output_dir —
// so the orchestration, error handling, and cue/SRT logic are proven for
// real without requiring the ML stack. Pure functions (buildCaptionCues,
// formatSrt, formatSrtTimestamp, escapeForFfmpegSubtitlesFilter) are
// tested directly with no mocking at all.

const FIXTURE: WhisperXResult = {
	segments: [
		{
			start: 0.2,
			end: 2.4,
			text: "hello world this is a test",
			words: [
				{ word: "hello", start: 0.2, end: 0.6 },
				{ word: "world", start: 0.65, end: 1.0 },
				{ word: "this", start: 1.05, end: 1.2 },
				{ word: "is", start: 1.25, end: 1.35 },
				{ word: "a", start: 1.4, end: 1.45 },
				{ word: "test", start: 1.5, end: 2.4 },
			],
		},
		{
			start: 5.0,
			end: 6.2,
			text: "second sentence",
			words: [
				{ word: "second", start: 5.0, end: 5.4 },
				{ word: "sentence", start: 5.5, end: 6.2 },
			],
		},
	],
};

const EMPTY_RESULT: WhisperXResult = { segments: [] };

function fakeDeps(opts: {
	ffmpegAvailable?: boolean;
	whisperxAvailable?: boolean;
	whisperxResult?: WhisperXResult;
	ffmpegExtractFails?: boolean;
	ffmpegBurnFails?: boolean;
	whisperxFails?: boolean;
	subtitlesFilterAvailable?: boolean;
}): CaptionDeps {
	const {
		ffmpegAvailable = true,
		whisperxAvailable = true,
		whisperxResult = FIXTURE,
		ffmpegExtractFails = false,
		ffmpegBurnFails = false,
		whisperxFails = false,
		subtitlesFilterAvailable = true,
	} = opts;

	const fake = (
		cmd: string,
		args: readonly string[] = [],
		_options?: unknown,
	): SpawnSyncReturns<Buffer> => {
		const ok = (stdout = ""): SpawnSyncReturns<Buffer> => ({
			pid: 1,
			output: [null, Buffer.from(stdout), Buffer.from("")],
			stdout: Buffer.from(stdout),
			stderr: Buffer.from(""),
			status: 0,
			signal: null,
		});
		const fail = (message: string): SpawnSyncReturns<Buffer> => ({
			pid: 1,
			output: [null, Buffer.from(""), Buffer.from(message)],
			stdout: Buffer.from(""),
			stderr: Buffer.from(message),
			status: 1,
			signal: null,
		});
		const notFound = (): SpawnSyncReturns<Buffer> => ({
			pid: 0,
			output: [null, null, null],
			stdout: Buffer.from(""),
			stderr: Buffer.from(""),
			status: null,
			signal: null,
			error: Object.assign(new Error(`spawnSync ${cmd} ENOENT`), { code: "ENOENT" }),
		});

		if (cmd === "ffmpeg" && args[0] === "-version") {
			return ffmpegAvailable ? ok() : notFound();
		}
		if (cmd === "ffmpeg" && args[0] === "-filters") {
			// mirrors real `ffmpeg -filters` output shape: "flags name  I/O  desc"
			return ok(
				subtitlesFilterAvailable ? " .. subtitles         V->V       Render text subtitles.\n" : "",
			);
		}
		if (cmd === "ffmpeg" && args.includes("-vn")) {
			// audio extraction — real ffmpeg would write the wav at the last arg
			if (!ffmpegAvailable) return notFound();
			if (ffmpegExtractFails) return fail("ffmpeg: extraction boom");
			writeFileSync(args[args.length - 1] as string, "fake wav", "utf-8");
			return ok();
		}
		if (cmd === "ffmpeg" && args.some((a) => a.startsWith("subtitles="))) {
			// burn-in — real ffmpeg would write the composited video at the last arg
			if (ffmpegBurnFails) return fail("ffmpeg: burn-in boom");
			writeFileSync(args[args.length - 1] as string, "fake captioned video", "utf-8");
			return ok();
		}
		if (cmd === "whisperx") {
			if (!whisperxAvailable) return notFound();
			if (whisperxFails) return fail("whisperx: transcription boom");
			const outDirIdx = args.indexOf("--output_dir");
			const outDir = args[outDirIdx + 1] as string;
			writeFileSync(path.join(outDir, "audio.json"), JSON.stringify(whisperxResult), "utf-8");
			return ok();
		}
		throw new Error(`fakeDeps: unexpected command ${cmd} ${args.join(" ")}`);
	};

	return { spawnSync: fake as unknown as CaptionDeps["spawnSync"] };
}

describe("formatSrtTimestamp", () => {
	it("formats zero", () => {
		expect(formatSrtTimestamp(0)).toBe("00:00:00,000");
	});
	it("formats sub-minute with ms", () => {
		expect(formatSrtTimestamp(1.234)).toBe("00:00:01,234");
	});
	it("formats over an hour", () => {
		expect(formatSrtTimestamp(3661.5)).toBe("01:01:01,500");
	});
	it("clamps negative to zero", () => {
		expect(formatSrtTimestamp(-2)).toBe("00:00:00,000");
	});
});

describe("buildCaptionCues", () => {
	it("groups words into cues respecting the word-gap boundary", () => {
		const cues = buildCaptionCues(FIXTURE);
		// segment 1 has no gap > MAX_WORD_GAP_S (1s) between its own words,
		// so it stays one cue; segment 2 is a separate cue (different
		// WhisperX segment).
		expect(cues.length).toBe(2);
		expect(cues[0]?.text).toBe("hello world this is a test");
		expect(cues[0]?.start).toBeCloseTo(0.2);
		expect(cues[0]?.end).toBeCloseTo(2.4);
		expect(cues[1]?.text).toBe("second sentence");
	});

	it("splits a cue when the word gap exceeds the pause threshold", () => {
		const result: WhisperXResult = {
			segments: [
				{
					start: 0,
					end: 5,
					text: "one two gap three four",
					words: [
						{ word: "one", start: 0, end: 0.2 },
						{ word: "two", start: 0.3, end: 0.5 },
						// > 1s gap here
						{ word: "gap", start: 2.0, end: 2.2 },
						{ word: "three", start: 2.3, end: 2.5 },
						{ word: "four", start: 2.6, end: 2.8 },
					],
				},
			],
		};
		const cues = buildCaptionCues(result);
		expect(cues.length).toBe(2);
		expect(cues[0]?.text).toBe("one two");
		expect(cues[1]?.text).toBe("gap three four");
	});

	it("splits a cue when it exceeds MAX_WORDS_PER_CUE (7)", () => {
		const words = Array.from({ length: 10 }, (_, i) => ({
			word: `w${i}`,
			start: i * 0.2,
			end: i * 0.2 + 0.15,
		}));
		const result: WhisperXResult = {
			segments: [{ start: 0, end: 2, text: words.map((w) => w.word).join(" "), words }],
		};
		const cues = buildCaptionCues(result);
		expect(cues.length).toBeGreaterThanOrEqual(2);
		expect(cues[0]?.text.split(" ").length).toBeLessThanOrEqual(7);
	});

	it("falls back to segment-level text when no word timings are present", () => {
		const result: WhisperXResult = {
			segments: [{ start: 1, end: 3, text: "no word timings here" }],
		};
		const cues = buildCaptionCues(result);
		expect(cues).toEqual([{ start: 1, end: 3, text: "no word timings here" }]);
	});

	it("returns an empty array for a silent transcript (no segments)", () => {
		expect(buildCaptionCues(EMPTY_RESULT)).toEqual([]);
	});
});

describe("formatSrt", () => {
	it("renders a well-formed, index-1 SRT for multiple cues", () => {
		const srt = formatSrt([
			{ start: 0, end: 1.5, text: "hello" },
			{ start: 2, end: 3.25, text: "world" },
		]);
		expect(srt).toBe(
			"1\n00:00:00,000 --> 00:00:01,500\nhello\n\n2\n00:00:02,000 --> 00:00:03,250\nworld\n",
		);
	});

	it("renders an empty (but valid) document for zero cues", () => {
		expect(formatSrt([])).toBe("");
	});

	it("never emits a zero-or-negative-duration cue (end >= start + 10ms)", () => {
		const srt = formatSrt([{ start: 1, end: 1, text: "x" }]);
		expect(srt).toContain("00:00:01,000 --> 00:00:01,010");
	});
});

describe("CAPTION_STYLE", () => {
	it("is the bar look, never the old outline look", () => {
		expect(CAPTION_STYLE).toContain("BorderStyle=4");
		expect(CAPTION_STYLE).not.toMatch(/BorderStyle=1\b/);
		expect(CAPTION_STYLE).toContain("Shadow=0");
		expect(CAPTION_STYLE).toContain("FontName=Helvetica Neue");
	});
});

describe("escapeForFfmpegSubtitlesFilter", () => {
	it("escapes colons (macOS/Linux absolute paths are fine, but drive-letter-style or option-separator collisions are not)", () => {
		expect(escapeForFfmpegSubtitlesFilter("/tmp/a:b.srt")).toBe("/tmp/a\\:b.srt");
	});
	it("escapes backslashes and single quotes", () => {
		expect(escapeForFfmpegSubtitlesFilter("C:\\it's\\a.srt")).toBe("C\\:\\\\it\\'s\\\\a.srt");
	});
});

describe("runCaption (orchestration, fake spawnSync)", () => {
	const tmpFiles: string[] = [];
	const inputVideo = path.join(tmpdir(), "lensmith-caption-test-input.mp4");

	function tmpOut(name: string): string {
		const p = path.join(tmpdir(), `lensmith-caption-test-${name}`);
		tmpFiles.push(p);
		return p;
	}

	// A real file just needs to exist for the `--in` existsSync check —
	// its content is never read by the fake ffmpeg/whisperx.
	writeFileSync(inputVideo, "not a real video, just needs to exist", "utf-8");
	tmpFiles.push(inputVideo);

	afterEach(() => {
		for (const f of tmpFiles.splice(0)) {
			rmSync(f, { force: true });
		}
		writeFileSync(inputVideo, "not a real video, just needs to exist", "utf-8");
		tmpFiles.push(inputVideo);
	});

	it("returns 1 and a clear message when --in does not exist", () => {
		const out = tmpOut("out1.mp4");
		const code = runCaption(
			{ in: "/tmp/lensmith-does-not-exist-xyz.mp4", out, burnIn: true },
			fakeDeps({}),
		);
		expect(code).toBe(1);
		expect(existsSync(out)).toBe(false);
	});

	it("returns 1 with a clear message when ffmpeg is not on PATH", () => {
		const out = tmpOut("out2.mp4");
		const code = runCaption(
			{ in: inputVideo, out, burnIn: true },
			fakeDeps({ ffmpegAvailable: false }),
		);
		expect(code).toBe(1);
	});

	it("returns 1 with an actionable message when ffmpeg lacks the subtitles filter (no libass) and --burn-in is requested", () => {
		// Real finding (forge report, CR-LENSMITH-A001-5): stock `brew install
		// ffmpeg` on macOS ships without libass/freetype — neither `subtitles`
		// nor `drawtext` exists — so --burn-in must fail fast and clearly
		// rather than dying deep inside ffmpeg's filtergraph parser.
		const out = tmpOut("out3b.mp4");
		const code = runCaption(
			{ in: inputVideo, out, burnIn: true },
			fakeDeps({ subtitlesFilterAvailable: false }),
		);
		expect(code).toBe(1);
		expect(existsSync(out)).toBe(false);
	});

	it("does NOT require the subtitles filter when --no-burn-in is passed", () => {
		const out = tmpOut("out3c.mp4");
		const srtOut = tmpOut("out3c.srt");
		const code = runCaption(
			{ in: inputVideo, out, burnIn: false, srtOut },
			fakeDeps({ subtitlesFilterAvailable: false }),
		);
		expect(code).toBe(0);
	});

	it("returns 1 with a clear message when WhisperX is not on PATH (not a silent empty-caption pass)", () => {
		const out = tmpOut("out3.mp4");
		const code = runCaption(
			{ in: inputVideo, out, burnIn: true },
			fakeDeps({ whisperxAvailable: false }),
		);
		expect(code).toBe(1);
		expect(existsSync(out)).toBe(false);
	});

	it("returns 1 when WhisperX errors out (not a silent empty-caption pass)", () => {
		const out = tmpOut("out4.mp4");
		const code = runCaption(
			{ in: inputVideo, out, burnIn: true },
			fakeDeps({ whisperxFails: true }),
		);
		expect(code).toBe(1);
		expect(existsSync(out)).toBe(false);
	});

	it("happy path: writes --srt-out and burns in captions to --out", () => {
		const out = tmpOut("out5.mp4");
		const srtOut = tmpOut("out5.srt");
		const code = runCaption({ in: inputVideo, out, burnIn: true, srtOut }, fakeDeps({}));
		expect(code).toBe(0);
		expect(existsSync(out)).toBe(true);
		expect(existsSync(srtOut)).toBe(true);
		const srt = readFileSync(srtOut, "utf-8");
		expect(srt).toContain("hello world this is a test");
		expect(srt).toMatch(/^\d+\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/m);
	});

	it("burn-in passes the shared CAPTION_STYLE to ffmpeg", () => {
		const base = fakeDeps({});
		const calls: string[][] = [];
		const deps: CaptionDeps = {
			spawnSync: ((cmd: string, args: readonly string[] = [], o?: unknown) => {
				calls.push([cmd, ...args]);
				return (
					base.spawnSync as unknown as (c: string, a: readonly string[], o?: unknown) => unknown
				)(cmd, args, o);
			}) as unknown as CaptionDeps["spawnSync"],
		};
		expect(runCaption({ in: inputVideo, out: tmpOut("out-style.mp4"), burnIn: true }, deps)).toBe(
			0,
		);
		const burn = calls.find((c) => c.some((a) => a.startsWith("subtitles=")));
		const filter = burn?.find((a) => a.startsWith("subtitles=")) ?? "";
		expect(filter).toContain(`force_style='${CAPTION_STYLE}'`);
	});

	it("--no-burn-in: --out is an unchanged copy, --srt-out is still written", () => {
		const out = tmpOut("out6.mp4");
		const srtOut = tmpOut("out6.srt");
		const code = runCaption({ in: inputVideo, out, burnIn: false, srtOut }, fakeDeps({}));
		expect(code).toBe(0);
		expect(readFileSync(out, "utf-8")).toBe(readFileSync(inputVideo, "utf-8"));
		expect(existsSync(srtOut)).toBe(true);
	});

	it("silent input (empty transcript): near-empty SRT, no crash, --out unchanged even with burn-in on", () => {
		const out = tmpOut("out7.mp4");
		const srtOut = tmpOut("out7.srt");
		const code = runCaption(
			{ in: inputVideo, out, burnIn: true, srtOut },
			fakeDeps({ whisperxResult: EMPTY_RESULT }),
		);
		expect(code).toBe(0);
		expect(readFileSync(out, "utf-8")).toBe(readFileSync(inputVideo, "utf-8"));
		expect(readFileSync(srtOut, "utf-8")).toBe("");
	});

	it("leaves no lensmith-caption-* temp directories behind after success or failure", () => {
		// Directories only — output files like `lensmith-caption-test-out8.mp4`
		// (from tmpOut() above) intentionally share the same name prefix and
		// must NOT be counted as a leaked mkdtempSync() working directory.
		const listTmp = () =>
			readdirSync(tmpdir(), { withFileTypes: true })
				.filter((e) => e.isDirectory() && e.name.startsWith("lensmith-caption-"))
				.map((e) => e.name);
		const before = listTmp();

		runCaption({ in: inputVideo, out: tmpOut("out8.mp4"), burnIn: true }, fakeDeps({}));
		runCaption(
			{ in: inputVideo, out: tmpOut("out9.mp4"), burnIn: true },
			fakeDeps({ whisperxFails: true }),
		);

		expect(listTmp().length).toBe(before.length);
	});
});
