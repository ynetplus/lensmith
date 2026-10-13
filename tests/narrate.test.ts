import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	captionCues,
	markTimes,
	type NarrateDeps,
	runNarrate,
	splitMarks,
	type Timings,
	validateTimings,
	type Word,
} from "../src/commands/narrate.js";

// The Python helper (scripts/narrate.py, Kokoro / Edge TTS) is never run here: CI has no
// uv, no Kokoro model and no network. A fake `spawnSync` plays the helper's contract —
// read the job file, write each audio file and the result JSON with word timings — so the
// Node side (mark parsing, mark times, cues, timings.json, cache) is tested for real.
// The speech-bounds detector is plain Python (standard library for WAV), so it runs for real.

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
	const d = mkdtempSync(path.join(tmpdir(), "lensmith-narrate-"));
	tmpDirs.push(d);
	return d;
}

/** Fake words: each word of the clean text takes 300 ms, starting at 100 ms. */
function fakeWords(text: string): Word[] {
	return (text.match(/[A-Za-z0-9']+/g) ?? []).map((w, i) => ({
		text: w,
		startMs: 100 + i * 300,
		endMs: 100 + i * 300 + 250,
	}));
}

interface Fake {
	deps: NarrateDeps;
	helperRuns: { id: string; text: string }[][];
	measureRuns: string[][];
	logs: string[];
	errors: string[];
}

function fakeDeps(opts: { uv?: boolean; helperStatus?: number; noBounds?: boolean } = {}): Fake {
	const helperRuns: { id: string; text: string }[][] = [];
	const measureRuns: string[][] = [];
	const logs: string[] = [];
	const errors: string[] = [];
	const ok = (status: number) =>
		({ status, error: undefined }) as unknown as SpawnSyncReturns<Buffer>;
	const spawn = ((cmd: string, args: string[]) => {
		if (cmd === "uv" && args[0] === "--version") {
			if (opts.uv === false) {
				const error = Object.assign(new Error("spawn uv ENOENT"), { code: "ENOENT" });
				return { status: null, error } as unknown as SpawnSyncReturns<Buffer>;
			}
			return ok(0);
		}
		if (cmd === "uv" && args[0] === "run") {
			const [jobPath, resultPath] = args.slice(-2) as [string, string];
			const job = JSON.parse(readFileSync(jobPath, "utf-8")) as {
				measure?: boolean;
				lines: { id: string; text: string; file: string }[];
			};
			if (job.measure) {
				measureRuns.push(job.lines.map((l) => l.id));
				const lines = Object.fromEntries(
					job.lines.map((l) => [l.id, { speechStartMs: 120, speechEndMs: 900 }]),
				);
				writeFileSync(resultPath, JSON.stringify({ lines }));
				return ok(0);
			}
			helperRuns.push(job.lines.map((l) => ({ id: l.id, text: l.text })));
			if (opts.helperStatus) return ok(opts.helperStatus);
			const lines: Record<string, object> = {};
			for (const l of job.lines) {
				writeFileSync(l.file, "RIFF-fake-audio");
				const words = fakeWords(l.text);
				const durationMs = 100 + words.length * 300 + 200;
				lines[l.id] = opts.noBounds
					? { durationMs, words }
					: { durationMs, speechStartMs: 100, speechEndMs: durationMs - 200, words };
			}
			writeFileSync(resultPath, JSON.stringify({ lines }));
			return ok(0);
		}
		throw new Error(`unexpected spawn: ${cmd} ${args.join(" ")}`);
	}) as unknown as NarrateDeps["spawnSync"];
	return {
		deps: {
			spawnSync: spawn,
			helperPath: "/fake/scripts/narrate.py",
			log: (s) => logs.push(s),
			error: (s) => errors.push(s),
		},
		helperRuns,
		measureRuns,
		logs,
		errors,
	};
}

function writeScript(dir: string, script: unknown): string {
	const p = path.join(dir, "narration.json");
	writeFileSync(p, JSON.stringify(script));
	return p;
}

const TWO_LINES = {
	lines: [
		{ id: "l1", text: "Open the [[story]] Buildr story to see the product." },
		{ id: "l2", text: "Then [[back]] go back to all companies. Pick one." },
	],
};

describe("splitMarks", () => {
	it("returns clean text and the position of the word after each mark", () => {
		const { clean, marks } = splitMarks("Click [[go]] Get started to [[end]] begin.");
		expect(clean).toBe("Click Get started to begin.");
		expect(marks).toEqual({ go: 6, end: 21 });
		expect(clean.slice(marks.go)).toMatch(/^Get/);
		expect(clean.slice(marks.end)).toMatch(/^begin/);
	});

	it("handles a mark at the start of the line", () => {
		expect(splitMarks("[[a]] Hello there.")).toEqual({ clean: "Hello there.", marks: { a: 0 } });
	});

	it("rejects a duplicate mark in one line", () => {
		expect(() => splitMarks("[[a]] one [[a]] two")).toThrow(/duplicate mark 'a'/);
	});
});

describe("markTimes and captionCues", () => {
	it("a mark's time is the start of the word after it (QA: [[go]] Get)", () => {
		const { clean, marks } = splitMarks("Click [[go]] Get started to begin.");
		const words = fakeWords(clean);
		expect(markTimes(clean, marks, words)).toEqual({ go: 400 }); // "Get" = word 1
	});

	it("rejects a mark with no spoken word after it", () => {
		const { clean, marks } = splitMarks("Done. [[late]]");
		expect(() => markTimes(clean, marks, fakeWords(clean))).toThrow(/not followed/);
	});

	it("builds one cue per sentence covering its words", () => {
		const clean = "Go back to all companies. Pick one.";
		const cues = captionCues(clean, fakeWords(clean));
		expect(cues).toEqual([
			{ startMs: 100, endMs: 1550, text: "Go back to all companies." },
			{ startMs: 1600, endMs: 2150, text: "Pick one." },
		]);
	});
});

describe("validateTimings", () => {
	const good: Timings = {
		lines: {
			l1: {
				file: "l1.wav",
				durationMs: 1000,
				marks: { a: 200 },
				words: [{ text: "Hi", startMs: 200, endMs: 500 }],
				cues: [{ startMs: 200, endMs: 500, text: "Hi." }],
			},
		},
	};
	it("accepts the documented shape", () => {
		expect(() => validateTimings(good)).not.toThrow();
	});
	it("accepts speech bounds inside the line, and lines without them (older caches)", () => {
		const withBounds = structuredClone(good);
		Object.assign(withBounds.lines.l1 as object, { speechStartMs: 150, speechEndMs: 900 });
		expect(() => validateTimings(withBounds)).not.toThrow();
		const edge = structuredClone(good);
		Object.assign(edge.lines.l1 as object, { speechStartMs: 0, speechEndMs: 1000 });
		expect(() => validateTimings(edge)).not.toThrow();
	});
	it.each([
		["start after end", { speechStartMs: 600, speechEndMs: 500 }],
		["start equal to end", { speechStartMs: 500, speechEndMs: 500 }],
		["end past durationMs", { speechStartMs: 100, speechEndMs: 1001 }],
		["negative start", { speechStartMs: -1, speechEndMs: 500 }],
		["non-integer", { speechStartMs: 100.5, speechEndMs: 500 }],
		["only one of the two", { speechStartMs: 100 }],
	])("rejects speech bounds: %s", (_name, b) => {
		const bad = structuredClone(good);
		Object.assign(bad.lines.l1 as object, b);
		expect(() => validateTimings(bad)).toThrow(/speechStartMs\/speechEndMs/);
	});
	it("rejects a mark outside its line", () => {
		const bad = structuredClone(good);
		(bad.lines.l1 as { marks: Record<string, number> }).marks.a = 1500;
		expect(() => validateTimings(bad)).toThrow(/outside the line/);
	});
});

describe("runNarrate (helper stubbed)", () => {
	it("writes timings.json in the documented shape, one audio file per line", () => {
		const dir = tmp();
		const out = path.join(dir, "audio");
		const fake = fakeDeps();
		const code = runNarrate({ script: writeScript(dir, TWO_LINES), out }, fake.deps);
		expect(fake.errors).toEqual([]);
		expect(code).toBe(0);
		// The helper receives clean text, never [[mark]] tags.
		expect(fake.helperRuns).toEqual([
			[
				{ id: "l1", text: "Open the Buildr story to see the product." },
				{ id: "l2", text: "Then go back to all companies. Pick one." },
			],
		]);
		const t = JSON.parse(readFileSync(path.join(out, "timings.json"), "utf-8")) as Timings;
		expect(Object.keys(t.lines)).toEqual(["l1", "l2"]);
		const l1 = t.lines.l1;
		const l2 = t.lines.l2;
		expect(l1?.file).toBe("l1.wav");
		expect(l1?.marks).toEqual({ story: 700 }); // "Buildr" = word 2
		expect(l2?.marks).toEqual({ back: 400 }); // "go" = word 1
		expect(l1?.words[0]).toEqual({ text: "Open", startMs: 100, endMs: 350 });
		expect(l2?.cues.map((c) => c.text)).toEqual(["Then go back to all companies.", "Pick one."]);
		for (const line of Object.values(t.lines)) {
			expect(Object.keys(line).sort()).toEqual([
				"cues",
				"durationMs",
				"file",
				"marks",
				"speechEndMs",
				"speechStartMs",
				"words",
			]);
			expect(line.durationMs).toBeGreaterThan(0);
			expect(line.speechStartMs).toBe(100);
			expect(line.speechEndMs).toBe(line.durationMs - 200);
		}
		expect(readFileSync(path.join(out, "l2.wav"), "utf-8")).toBe("RIFF-fake-audio");
		expect(fake.logs[0]).toMatch(/2 synthesized, 0 cached; kokoro am_michael/);
	});

	it("skips unchanged lines on a second run and re-synthesizes only a changed one", () => {
		const dir = tmp();
		const out = path.join(dir, "audio");
		const first = fakeDeps();
		expect(runNarrate({ script: writeScript(dir, TWO_LINES), out }, first.deps)).toBe(0);

		const second = fakeDeps();
		expect(runNarrate({ script: writeScript(dir, TWO_LINES), out, json: true }, second.deps)).toBe(
			0,
		);
		expect(second.helperRuns).toEqual([]); // no helper call at all
		const env = JSON.parse(second.logs[0] as string);
		expect(env.ok).toBe(true);
		expect(env.lines.map((l: { cached: boolean }) => l.cached)).toEqual([true, true]);

		// Moving a mark does not change the spoken text, so it stays cached.
		const moved = structuredClone(TWO_LINES);
		(moved.lines[1] as { text: string }).text = "Then go [[back]] back to all companies. Pick one.";
		(moved.lines[0] as { text: string }).text = "Open the [[story]] Buildr story to see it.";
		const third = fakeDeps();
		expect(runNarrate({ script: writeScript(dir, moved), out }, third.deps)).toBe(0);
		expect(third.helperRuns).toEqual([[{ id: "l1", text: "Open the Buildr story to see it." }]]);
		const t = JSON.parse(readFileSync(path.join(out, "timings.json"), "utf-8")) as Timings;
		expect(t.lines.l2?.marks).toEqual({ back: 700 }); // now "back" = word 2
	});

	it("a voice change invalidates the cache", () => {
		const dir = tmp();
		const out = path.join(dir, "audio");
		runNarrate({ script: writeScript(dir, TWO_LINES), out }, fakeDeps().deps);
		const again = fakeDeps();
		runNarrate({ script: writeScript(dir, TWO_LINES), out, voice: "af_heart" }, again.deps);
		expect(again.helperRuns[0]?.map((l) => l.id)).toEqual(["l1", "l2"]);
	});

	it("rejects a duplicate mark before running the helper", () => {
		const dir = tmp();
		const fake = fakeDeps();
		const script = writeScript(dir, { lines: [{ id: "a", text: "[[x]] one [[x]] two" }] });
		expect(runNarrate({ script, out: path.join(dir, "o") }, fake.deps)).toBe(1);
		expect(fake.errors[0]).toMatch(/duplicate mark 'x'/);
		expect(fake.helperRuns).toEqual([]);
	});

	it("fails with an install hint when uv is missing", () => {
		const dir = tmp();
		const fake = fakeDeps({ uv: false });
		expect(
			runNarrate({ script: writeScript(dir, TWO_LINES), out: path.join(dir, "o") }, fake.deps),
		).toBe(1);
		expect(fake.errors[0]).toMatch(/uv not found on PATH.*brew install uv/);
	});

	it("--engine edge without edge-tts installed fails with an actionable message", () => {
		const dir = tmp();
		const fake = fakeDeps({ helperStatus: 3 }); // helper: "missing package: edge-tts"
		const code = runNarrate(
			{ script: writeScript(dir, TWO_LINES), out: path.join(dir, "o"), engine: "edge" },
			fake.deps,
		);
		expect(code).toBe(1);
		expect(fake.errors[0]).toMatch(/needs the 'edge-tts' Python package/);
		expect(fake.errors[0]).toMatch(/uv run --with edge-tts/);
		expect(fake.helperRuns[0]?.length).toBe(2);
	});

	it("uses Edge's default voice and mp3 files for --engine edge", () => {
		const dir = tmp();
		const out = path.join(dir, "o");
		const fake = fakeDeps();
		expect(
			runNarrate({ script: writeScript(dir, TWO_LINES), out, engine: "edge" }, fake.deps),
		).toBe(0);
		expect(fake.logs[0]).toMatch(/edge en-US-AndrewNeural/);
		const t = JSON.parse(readFileSync(path.join(out, "timings.json"), "utf-8")) as Timings;
		expect(t.lines.l1?.file).toBe("l1.mp3");
	});
});

describe("speech bounds", () => {
	it("re-measures cached lines without bounds instead of re-synthesizing them", () => {
		const dir = tmp();
		const out = path.join(dir, "audio");
		expect(
			runNarrate({ script: writeScript(dir, TWO_LINES), out }, fakeDeps({ noBounds: true }).deps),
		).toBe(0);
		const before = JSON.parse(readFileSync(path.join(out, "timings.json"), "utf-8")) as Timings;
		expect(before.lines.l1?.speechStartMs).toBeUndefined();

		const again = fakeDeps();
		expect(runNarrate({ script: writeScript(dir, TWO_LINES), out }, again.deps)).toBe(0);
		expect(again.helperRuns).toEqual([]); // nothing re-synthesized
		expect(again.measureRuns).toEqual([["l1", "l2"]]);
		const t = JSON.parse(readFileSync(path.join(out, "timings.json"), "utf-8")) as Timings;
		expect(t.lines.l1).toMatchObject({ speechStartMs: 120, speechEndMs: 900 });
		expect(t.lines.l1?.durationMs).toBe(before.lines.l1?.durationMs);
		expect(readFileSync(path.join(out, "l1.wav"), "utf-8")).toBe("RIFF-fake-audio");

		const third = fakeDeps(); // bounds now cached: no helper run at all
		expect(runNarrate({ script: writeScript(dir, TWO_LINES), out }, third.deps)).toBe(0);
		expect(third.helperRuns).toEqual([]);
		expect(third.measureRuns).toEqual([]);
	});

	it("detects the voice inside a clip's silence (400 ms + tone + 650 ms, 24 kHz WAV)", () => {
		const rate = 24000;
		const lead = (0.4 * rate) | 0;
		const tone = (1.2 * rate) | 0;
		const tail = (0.65 * rate) | 0;
		const n = lead + tone + tail;
		const wav = Buffer.alloc(44 + n * 2);
		wav.write("RIFF", 0);
		wav.writeUInt32LE(36 + n * 2, 4);
		wav.write("WAVEfmt ", 8);
		wav.writeUInt32LE(16, 16);
		wav.writeUInt16LE(1, 20); // PCM
		wav.writeUInt16LE(1, 22); // mono
		wav.writeUInt32LE(rate, 24);
		wav.writeUInt32LE(rate * 2, 28);
		wav.writeUInt16LE(2, 32);
		wav.writeUInt16LE(16, 34);
		wav.write("data", 36);
		wav.writeUInt32LE(n * 2, 40);
		for (let i = 0; i < tone; i++) {
			const v = Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 220 * i) / rate));
			wav.writeInt16LE(v, 44 + (lead + i) * 2);
		}
		// A little noise floor below -40 dBFS in the silences must not count as speech.
		for (let i = 0; i < lead; i += 7) wav.writeInt16LE(100, 44 + i * 2);
		const file = path.join(tmp(), "line.wav");
		writeFileSync(file, wav);

		const helper = path.resolve(import.meta.dirname, "../scripts/narrate.py");
		const r = spawnSync("python3", [helper, "--bounds", file], { encoding: "utf-8" });
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		const b = JSON.parse(r.stdout) as { speechStartMs: number; speechEndMs: number };
		const durationMs = Math.round((n / rate) * 1000);
		expect(Math.abs(b.speechStartMs - 400)).toBeLessThanOrEqual(15);
		expect(Math.abs(b.speechEndMs - (durationMs - 650))).toBeLessThanOrEqual(15);
		expect(b.speechStartMs).toBeLessThan(b.speechEndMs);
	});
});
