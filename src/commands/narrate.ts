import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";

/**
 * `lensmith narrate` — turns a narration script into one audio file per line plus a
 * `timings.json` (CR-LENSMITH-A008-1). Synthesis runs in a Python helper
 * (`scripts/narrate.py`) launched with `uv run`; this file owns the data model so it is
 * testable without Python: `[[mark]]` parsing, mark times, one caption cue per sentence,
 * and the hash cache that skips unchanged lines.
 *
 * The data model (marks before a word, mark time = start of the next spoken word, one cue
 * per sentence, regenerate only changed lines) is adapted from Papermorph's scripts/tts.py
 * (https://github.com/DozenTwelve/Papermorph), `split_marks`, `time_at`, `mark_times` and
 * `caption_cues`. Papermorph is MIT licensed:
 *
 *   MIT License
 *
 *   Copyright (c) 2026 TedKaczynski
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 */

export type NarrateEngine = "kokoro" | "edge";

export const DEFAULT_VOICES: Record<NarrateEngine, string> = {
	kokoro: "am_michael",
	edge: "en-US-AndrewNeural",
};

const AUDIO_EXT: Record<NarrateEngine, string> = { kokoro: "wav", edge: "mp3" };

/** `uv run` arguments per engine. Kokoro supports Python 3.10–3.12, so pin 3.12. */
const UV_PACKAGES: Record<NarrateEngine, string[]> = {
	kokoro: [
		"--python",
		"3.12",
		"--with",
		"kokoro",
		"--with",
		"soundfile",
		"--with",
		"en-core-web-sm@https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl",
	],
	edge: ["--with", "edge-tts"],
};

const MISSING_PACKAGE_EXIT = 3;
const CACHE_FILE = ".narrate-cache.json";
const MARK = /\[\[(\w+)\]\]/g;
const LINE_ID = /^[A-Za-z0-9_-]+$/;

export interface NarrationScript {
	voice?: string;
	engine?: string;
	lines: { id: string; text: string }[];
}

export interface Word {
	text: string;
	startMs: number;
	endMs: number;
}

export interface Cue {
	startMs: number;
	endMs: number;
	text: string;
}

/**
 * Where the voice sits inside a line's clip: first and last moment above -40 dBFS, in ms from
 * the start of the file. The clip keeps its own leading/trailing silence (word times stay
 * file-relative); a consumer that wants lines back to back schedules by these bounds.
 */
export interface SpeechBounds {
	speechStartMs: number;
	speechEndMs: number;
}

export interface LineTimings extends Partial<SpeechBounds> {
	file: string;
	durationMs: number;
	marks: Record<string, number>;
	words: Word[];
	cues: Cue[];
}

export interface Timings {
	lines: Record<string, LineTimings>;
}

interface CacheEntry extends Partial<SpeechBounds> {
	key: string;
	file: string;
	durationMs: number;
	words: Word[];
}

interface HelperResult {
	lines: Record<string, Partial<SpeechBounds> & { durationMs: number; words: Word[] }>;
}

const hasBounds = (e: Partial<SpeechBounds>): e is SpeechBounds =>
	e.speechStartMs !== undefined && e.speechEndMs !== undefined;

export interface NarrateOptions {
	script: string;
	out: string;
	engine?: string;
	voice?: string;
	json?: boolean;
}

export interface NarrateDeps {
	spawnSync: typeof spawnSync;
	/** Absolute path of scripts/narrate.py. */
	helperPath: string;
	log: (s: string) => void;
	error: (s: string) => void;
}

export class NarrateError extends Error {}

const realDeps: NarrateDeps = {
	spawnSync,
	helperPath: path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../../scripts/narrate.py",
	),
	log: (s) => console.log(s),
	error: (s) => console.error(s),
};

/**
 * Strips `[[mark]]` tags. Returns the clean text and each mark's character position in it
 * (the position of the word the mark sits before). The space after a mark is dropped when
 * the mark already follows a space, so "the [[go]] Get" becomes "the Get", not "the  Get".
 */
export function splitMarks(raw: string): { clean: string; marks: Record<string, number> } {
	const marks: Record<string, number> = {};
	let clean = "";
	let last = 0;
	for (const m of raw.matchAll(MARK)) {
		clean += raw.slice(last, m.index);
		const name = m[1] as string;
		if (name in marks) throw new NarrateError(`duplicate mark '${name}' in one line`);
		last = (m.index ?? 0) + m[0].length;
		if (clean === "" || /\s$/.test(clean)) {
			while (last < raw.length && /\s/.test(raw[last] as string)) last++;
		}
		marks[name] = clean.length;
	}
	clean += raw.slice(last);
	return { clean, marks };
}

/** Locates each spoken word in the clean text, in order; words that cannot be found are skipped. */
function locateWords(clean: string, words: Word[]): (Word & { pos: number })[] {
	const located: (Word & { pos: number })[] = [];
	let cursor = 0;
	for (const w of words) {
		const i = clean.indexOf(w.text, cursor);
		if (i < 0) continue;
		located.push({ ...w, pos: i });
		cursor = i + w.text.length;
	}
	return located;
}

/** Each mark's time = start of the first spoken word at or after the mark's position. */
export function markTimes(
	clean: string,
	marks: Record<string, number>,
	words: Word[],
): Record<string, number> {
	const located = locateWords(clean, words);
	const out: Record<string, number> = {};
	for (const [name, pos] of Object.entries(marks)) {
		const hit = located.find((w) => w.pos >= pos);
		if (!hit) throw new NarrateError(`mark '${name}' is not followed by a spoken word`);
		out[name] = hit.startMs;
	}
	return out;
}

/** One caption cue per sentence, timed from the first to the last spoken word in it. */
export function captionCues(clean: string, words: Word[]): Cue[] {
	const located = locateWords(clean, words);
	const bounds = [...clean.matchAll(/[.?!]\s+/g)].map((m) => (m.index ?? 0) + m[0].length);
	bounds.push(clean.length);
	const cues: Cue[] = [];
	let start = 0;
	for (const end of bounds) {
		const text = clean.slice(start, end).trim();
		const inside = located.filter((w) => w.pos >= start && w.pos < end);
		const first = inside[0];
		const lastWord = inside[inside.length - 1];
		if (text && first && lastWord) {
			cues.push({ startMs: first.startMs, endMs: lastWord.endMs, text });
		}
		start = end;
	}
	return cues;
}

export function cacheKey(engine: string, voice: string, clean: string): string {
	return createHash("sha1").update(`${engine}|${voice}|${clean}`).digest("hex");
}

/** Throws if timings.json does not have the documented shape or a mark falls outside its line. */
export function validateTimings(t: Timings): void {
	if (!t || typeof t !== "object" || !t.lines || typeof t.lines !== "object") {
		throw new NarrateError("timings.json has no 'lines' object");
	}
	for (const [id, line] of Object.entries(t.lines)) {
		const where = `timings.json line '${id}'`;
		if (typeof line.file !== "string" || !line.file) throw new NarrateError(`${where}: no file`);
		if (!Number.isInteger(line.durationMs) || line.durationMs <= 0) {
			throw new NarrateError(`${where}: durationMs must be a positive integer`);
		}
		if (line.speechStartMs !== undefined || line.speechEndMs !== undefined) {
			const { speechStartMs: s, speechEndMs: e } = line;
			if (
				!Number.isInteger(s) ||
				!Number.isInteger(e) ||
				(s as number) < 0 ||
				(s as number) >= (e as number) ||
				(e as number) > line.durationMs
			) {
				throw new NarrateError(
					`${where}: speechStartMs/speechEndMs must be integers with ` +
						"0 <= speechStartMs < speechEndMs <= durationMs",
				);
			}
		}
		for (const [name, ms] of Object.entries(line.marks ?? {})) {
			if (!Number.isFinite(ms) || ms < 0 || ms > line.durationMs) {
				throw new NarrateError(`${where}: mark '${name}' (${ms} ms) is outside the line`);
			}
		}
		if (!Array.isArray(line.words) || !Array.isArray(line.cues)) {
			throw new NarrateError(`${where}: words and cues must be arrays`);
		}
		for (const c of [...line.words, ...line.cues]) {
			if (!(c.startMs >= 0 && c.endMs >= c.startMs && c.endMs <= line.durationMs + 50)) {
				throw new NarrateError(`${where}: a word or cue has times outside the line`);
			}
		}
	}
}

function parseScript(file: string): NarrationScript {
	if (!existsSync(file)) throw new NarrateError(`script not found: ${file}`);
	let script: NarrationScript;
	try {
		script = JSON.parse(readFileSync(file, "utf-8")) as NarrationScript;
	} catch (err) {
		throw new NarrateError(`script is not valid JSON: ${(err as Error).message}`);
	}
	if (!script || !Array.isArray(script.lines) || script.lines.length === 0) {
		throw new NarrateError("script needs a non-empty 'lines' array of {id, text}");
	}
	const seen = new Set<string>();
	for (const line of script.lines) {
		if (typeof line?.id !== "string" || !LINE_ID.test(line.id)) {
			throw new NarrateError(
				`line id ${JSON.stringify(line?.id)} must use only letters, digits, '-' and '_'`,
			);
		}
		if (seen.has(line.id)) throw new NarrateError(`duplicate line id '${line.id}'`);
		seen.add(line.id);
		if (typeof line.text !== "string" || !line.text.trim()) {
			throw new NarrateError(`line '${line.id}' has no text`);
		}
	}
	return script;
}

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function writeAtomic(file: string, text: string): void {
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, text, "utf-8");
	renameSync(tmp, file);
}

function uvAvailable(deps: NarrateDeps): boolean {
	const r = deps.spawnSync("uv", ["--version"], { stdio: "ignore" });
	return !r.error && r.status === 0;
}

function helperFailure(engine: NarrateEngine, status: number | null): NarrateError {
	if (engine === "edge") {
		return new NarrateError(
			"Edge TTS could not run. '--engine edge' needs the 'edge-tts' Python package, which " +
				"Lensmith does not bundle: Lensmith fetches it with 'uv run --with edge-tts' (network " +
				"access needed), and Edge TTS itself calls Microsoft's online service. Check your " +
				"connection, or run 'uv run --with edge-tts python -c \"import edge_tts\"' to see why " +
				`it fails${status === MISSING_PACKAGE_EXIT ? "" : ` (helper exit code ${status})`}.`,
		);
	}
	if (status === MISSING_PACKAGE_EXIT) {
		return new NarrateError(
			"Kokoro could not be loaded. Lensmith installs it with 'uv run --python 3.12 --with " +
				"kokoro --with soundfile' (first run needs network access); run " +
				"'uv run --python 3.12 --with kokoro python -c \"import kokoro\"' to see why it fails.",
		);
	}
	return new NarrateError(`narration helper failed (exit code ${status}); see the error above.`);
}

/** Runs `lensmith narrate`. Returns a process exit code (0 = success). */
export function runNarrate(opts: NarrateOptions, deps: NarrateDeps = realDeps): number {
	try {
		const script = parseScript(opts.script);
		const engineName = opts.engine ?? script.engine ?? "kokoro";
		if (engineName !== "kokoro" && engineName !== "edge") {
			throw new NarrateError(`unknown engine '${engineName}' (use kokoro or edge)`);
		}
		const engine: NarrateEngine = engineName;
		const voice = opts.voice ?? script.voice ?? DEFAULT_VOICES[engine];
		const outDir = path.resolve(opts.out);

		const lines = script.lines.map((l) => {
			const { clean, marks } = splitMarks(l.text);
			return {
				id: l.id,
				clean,
				marks,
				key: cacheKey(engine, voice, clean),
				file: `${l.id}.${AUDIO_EXT[engine]}`,
			};
		});

		mkdirSync(outDir, { recursive: true });
		const cachePath = path.join(outDir, CACHE_FILE);
		const cache = readJson<{ lines: Record<string, CacheEntry> }>(cachePath)?.lines ?? {};
		const fresh = (l: (typeof lines)[number]): boolean => {
			const hit = cache[l.id];
			if (!hit || hit.key !== l.key || hit.file !== l.file) return false;
			const audio = path.join(outDir, l.file);
			return existsSync(audio) && statSync(audio).size > 0;
		};
		const todo = lines.filter((l) => !fresh(l));
		// Cache entries written before speech bounds existed: measure the clip, never re-synthesize.
		const remeasure = lines.filter(
			(l) => !todo.includes(l) && !hasBounds(cache[l.id] as CacheEntry),
		);

		if (todo.length > 0 || remeasure.length > 0) {
			if (!uvAvailable(deps)) {
				throw new NarrateError(
					"uv not found on PATH. 'lensmith narrate' runs its Python TTS helper with uv. " +
						"Install it ('brew install uv' or 'curl -LsSf https://astral.sh/uv/install.sh | sh'), " +
						"then run this command again.",
				);
			}
			const runHelper = (job: object, uvArgs: string[]): HelperResult | undefined => {
				const jobPath = path.join(outDir, ".narrate-job.json");
				const resultPath = path.join(outDir, ".narrate-result.json");
				rmSync(resultPath, { force: true });
				writeFileSync(jobPath, JSON.stringify(job), "utf-8");
				// The helper's stdout goes to our stderr so --json output stays clean.
				const r = deps.spawnSync(
					"uv",
					["run", "--no-project", ...uvArgs, deps.helperPath, jobPath, resultPath],
					{ stdio: ["ignore", 2, 2] },
				);
				rmSync(jobPath, { force: true });
				if (r.error) throw new NarrateError(`could not start uv: ${r.error.message}`);
				if (r.status !== 0) throw helperFailure(engine, r.status);
				const result = readJson<HelperResult>(resultPath);
				rmSync(resultPath, { force: true });
				return result;
			};
			const bounds = (got: Partial<SpeechBounds>): Partial<SpeechBounds> =>
				hasBounds(got) ? { speechStartMs: got.speechStartMs, speechEndMs: got.speechEndMs } : {};
			if (todo.length > 0) {
				const result = runHelper(
					{
						engine,
						voice,
						lines: todo.map((l) => ({ id: l.id, text: l.clean, file: path.join(outDir, l.file) })),
					},
					UV_PACKAGES[engine],
				);
				for (const l of todo) {
					const got = result?.lines?.[l.id];
					if (!got)
						throw new NarrateError(`narration helper returned no result for line '${l.id}'`);
					cache[l.id] = {
						key: l.key,
						file: l.file,
						durationMs: got.durationMs,
						...bounds(got),
						words: got.words,
					};
				}
			}
			if (remeasure.length > 0) {
				const result = runHelper(
					{
						measure: true,
						lines: remeasure.map((l) => ({ id: l.id, file: path.join(outDir, l.file) })),
					},
					[],
				);
				for (const l of remeasure) {
					const got = result?.lines?.[l.id];
					if (!got)
						throw new NarrateError(`narration helper returned no result for line '${l.id}'`);
					cache[l.id] = { ...(cache[l.id] as CacheEntry), ...bounds(got) };
				}
			}
			writeAtomic(cachePath, `${JSON.stringify({ lines: cache }, null, 1)}\n`);
		}

		const timings: Timings = { lines: {} };
		for (const l of lines) {
			const c = cache[l.id] as CacheEntry;
			timings.lines[l.id] = {
				file: l.file,
				durationMs: c.durationMs,
				...(hasBounds(c) ? { speechStartMs: c.speechStartMs, speechEndMs: c.speechEndMs } : {}),
				marks: markTimes(l.clean, l.marks, c.words),
				words: c.words,
				cues: captionCues(l.clean, c.words),
			};
		}
		validateTimings(timings);
		const timingsPath = path.join(outDir, "timings.json");
		writeAtomic(timingsPath, `${JSON.stringify(timings, null, 2)}\n`);

		const cachedIds = new Set(lines.filter((l) => !todo.includes(l)).map((l) => l.id));
		if (opts.json) {
			deps.log(
				JSON.stringify({
					ok: true,
					engine,
					voice,
					timings: timingsPath,
					lines: lines.map((l) => ({
						id: l.id,
						file: path.join(outDir, l.file),
						durationMs: timings.lines[l.id]?.durationMs,
						speechStartMs: timings.lines[l.id]?.speechStartMs,
						speechEndMs: timings.lines[l.id]?.speechEndMs,
						cached: cachedIds.has(l.id),
					})),
				}),
			);
		} else {
			deps.log(
				`Narration written: ${timingsPath} (${lines.length} line${lines.length === 1 ? "" : "s"}: ` +
					`${todo.length} synthesized, ${cachedIds.size} cached; ${engine} ${voice})`,
			);
		}
		return 0;
	} catch (err) {
		const message = (err as Error).message;
		if (opts.json) deps.log(JSON.stringify({ ok: false, error: message }));
		else deps.error(`Error: ${message}`);
		return 1;
	}
}

export function registerNarrateCommand(program: Command): void {
	program
		.command("narrate")
		.description(
			"Synthesize narration lines to audio + timings.json (word times, [[mark]] times, caption cues)",
		)
		.requiredOption("--script <json>", "narration script: {voice?, engine?, lines:[{id, text}]}")
		.requiredOption("--out <dir>", "output folder for <id>.wav|mp3 and timings.json")
		.option("--engine <name>", "kokoro (default, local) or edge (online, see below)")
		.option(
			"--voice <id>",
			"voice id (default: am_michael for kokoro, en-US-AndrewNeural for edge)",
		)
		.option("--json", "print a machine-readable JSON result", false)
		.addHelpText(
			"after",
			[
				"",
				"Put [[name]] before the word an action should land on; timings.json gives the time",
				"(ms) that word starts. Unchanged lines are reused from the output folder's cache.",
				"Needs uv (https://docs.astral.sh/uv/) to run the Python TTS helper.",
				"",
				"Engines:",
				"  kokoro  Default. Local Kokoro-82M (Apache-2.0). Runs offline, except that uv",
				"          installs the Python packages and the model weights download once from",
				"          Hugging Face on first use.",
				"  edge    Optional. Edge TTS is an unofficial client for Microsoft's online Read",
				"          Aloud service, not a Microsoft product or API. Lensmith does not bundle it:",
				"          choosing --engine edge installs the edge-tts package through uv and sends",
				"          your narration text to Microsoft over the network. Also needs ffprobe.",
			].join("\n"),
		)
		.action((opts: NarrateOptions) => {
			const code = runNarrate(opts);
			if (code !== 0) process.exitCode = code;
		});
}
