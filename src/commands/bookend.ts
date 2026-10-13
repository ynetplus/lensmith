import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { chromium } from "playwright";
import {
	type BookendPlan,
	buildBookendPage,
	formatFromSize,
	frameCount,
	frameState,
	parseFormat,
	planBookend,
} from "../lib/bookend.js";
import { buildLaunchOptions } from "../lib/harnessRunner.js";

/**
 * `lensmith bookend` (CR-LENSMITH-A011-3): the Veil opening and the "Made with Lensmith" end
 * card around a finished film. The card frames are drawn by headless Chromium (the engine's
 * own renderer) from the ratified card CSS, so the type is the card's type; ffmpeg joins them.
 */

export class BookendError extends Error {}

interface BookendGlobal {
	__bookend: { setBackground(src: string): Promise<boolean>; set(state: unknown): void };
}

interface Probe {
	width: number;
	height: number;
	fps: number;
	fpsRaw: string;
	durationMs: number;
	hasAudio: boolean;
}

function run(cmd: string, args: string[], label: string): string {
	const r = spawnSync(cmd, args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
	if (r.error) {
		const code = (r.error as NodeJS.ErrnoException).code;
		throw new BookendError(
			code === "ENOENT"
				? `${label}: '${cmd}' not found on PATH. Install ffmpeg (on macOS 'brew install ffmpeg-full').`
				: `${label} failed to start: ${r.error.message}`,
		);
	}
	if (r.status !== 0) {
		throw new BookendError(`${label} exited with code ${r.status}.\n${(r.stderr ?? "").trim()}`);
	}
	return r.stdout ?? "";
}

function probe(file: string): Probe {
	const out = run(
		"ffprobe",
		[
			"-v",
			"error",
			"-show_entries",
			"stream=codec_type,width,height,r_frame_rate:format=duration",
			"-of",
			"json",
			file,
		],
		"ffprobe",
	);
	const j = JSON.parse(out) as {
		streams: { codec_type: string; width?: number; height?: number; r_frame_rate?: string }[];
		format: { duration?: string };
	};
	const v = j.streams.find((s) => s.codec_type === "video");
	if (!v?.width || !v.height) throw new BookendError(`${file} has no video stream`);
	const fpsRaw = v.r_frame_rate ?? "30/1";
	const [n = 30, d = 1] = fpsRaw.split("/").map(Number);
	const fps = d ? n / d : n;
	return {
		width: v.width,
		height: v.height,
		fps: fps > 0 && fps < 241 ? fps : 30,
		fpsRaw: fps > 0 && fps < 241 ? fpsRaw : "30/1",
		durationMs: Math.round(Number(j.format.duration ?? 0) * 1000),
		hasAudio: j.streams.some((s) => s.codec_type === "audio"),
	};
}

function assetPath(name: string): string {
	// dist/commands/bookend.js and src/commands/bookend.ts both sit two levels under the root.
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(here, "..", "..", "assets", "bookend", name);
}

/**
 * Renders one segment's frames into `dir` as frame-%06d.png. Unique states are screenshotted
 * once; repeated states are hard links, so a 4 s hold costs one screenshot.
 */
async function renderSegment(
	page: import("playwright").Page,
	plan: BookendPlan,
	phase: "open" | "end",
	totalMs: number,
	fps: number,
	background: string,
	dir: string,
): Promise<number> {
	mkdirSync(dir, { recursive: true });
	await page.evaluate(
		(src) => (globalThis as unknown as BookendGlobal).__bookend.setBackground(src),
		`data:image/png;base64,${readFileSync(background).toString("base64")}`,
	);
	const n = frameCount(totalMs, fps);
	let lastKey = "";
	let lastFile = "";
	let shots = 0;
	for (let i = 0; i < n; i++) {
		const st = frameState(plan, phase, (i * 1000) / fps);
		const key = JSON.stringify(st);
		const file = path.join(dir, `frame-${String(i).padStart(6, "0")}.png`);
		if (key === lastKey) {
			linkSync(lastFile, file);
			continue;
		}
		await page.evaluate((s) => (globalThis as unknown as BookendGlobal).__bookend.set(s), st);
		await page.screenshot({ path: file, type: "png" });
		shots++;
		lastKey = key;
		lastFile = file;
	}
	return shots;
}

export interface BookendOptions {
	in: string;
	out: string;
	hook?: string | boolean;
	endCard?: boolean;
	format?: string;
	hookVoice?: string;
	endCardHold?: string;
	json?: boolean;
}

export async function runBookend(opts: BookendOptions): Promise<Record<string, unknown>> {
	if (!existsSync(opts.in)) throw new BookendError(`--in file not found: ${opts.in}`);
	const hookText = typeof opts.hook === "string" ? opts.hook.trim() : "";
	if (opts.hookVoice && !existsSync(opts.hookVoice))
		throw new BookendError(`--hook-voice file not found: ${opts.hookVoice}`);
	if (opts.hookVoice && !hookText) throw new BookendError("--hook-voice needs --hook <text>");
	const input = probe(opts.in);
	const format = parseFormat(opts.format) ?? formatFromSize(input.width, input.height);
	const voiceMs = opts.hookVoice ? probe2Audio(opts.hookVoice) : null;
	const plan = planBookend({
		hookWords: hookText ? hookText.split(/\s+/).length : null,
		voiceMs,
		format,
		endCard: opts.endCard !== false,
		endHoldMs: opts.endCardHold !== undefined ? Number(opts.endCardHold) : undefined,
	});
	if (!plan.open && !plan.end) throw new BookendError("nothing to do: no --hook and --no-end-card");

	const work = mkdtempSync(path.join(tmpdir(), "lensmith-bookend-"));
	try {
		const first = path.join(work, "first.png");
		const last = path.join(work, "last.png");
		if (plan.open)
			run(
				"ffmpeg",
				["-v", "error", "-y", "-i", opts.in, "-frames:v", "1", first],
				"ffmpeg (first frame)",
			);
		if (plan.end)
			run(
				"ffmpeg",
				["-v", "error", "-y", "-sseof", "-0.5", "-i", opts.in, "-update", "1", last],
				"ffmpeg (last frame)",
			);

		const html = buildBookendPage({
			plan,
			width: input.width,
			height: input.height,
			fontDataUrl: `data:font/ttf;base64,${readFileSync(assetPath("BricolageGrotesque.ttf")).toString("base64")}`,
			lockupSvg: readFileSync(assetPath("lensmith-lockup.svg"), "utf8"),
			hookText,
		});
		const browser = await chromium.launch(buildLaunchOptions());
		let shots = 0;
		try {
			const page = await browser.newPage({
				viewport: { width: input.width, height: input.height },
			});
			await page.setContent(html);
			await page.evaluate("document.fonts.ready.then(() => true)");
			if (plan.open)
				shots += await renderSegment(
					page,
					plan,
					"open",
					plan.open.totalMs,
					input.fps,
					first,
					path.join(work, "open"),
				);
			if (plan.end)
				shots += await renderSegment(
					page,
					plan,
					"end",
					plan.end.totalMs,
					input.fps,
					last,
					path.join(work, "end"),
				);
		} finally {
			await browser.close();
		}

		const openMs = plan.open ? (frameCount(plan.open.totalMs, input.fps) * 1000) / input.fps : 0;
		const endMs = plan.end ? (frameCount(plan.end.totalMs, input.fps) * 1000) / input.fps : 0;
		const totalSec = (input.durationMs + openMs + endMs) / 1000;
		const args = ["-v", "error", "-y"];
		const vIn: string[] = [];
		let idx = 0;
		if (plan.open) {
			args.push("-framerate", input.fpsRaw, "-i", path.join(work, "open", "frame-%06d.png"));
			vIn.push(`[${idx++}:v]`);
		}
		const mainIdx = idx++;
		args.push("-i", opts.in);
		vIn.push(`[${mainIdx}:v]`);
		if (plan.end) {
			args.push("-framerate", input.fpsRaw, "-i", path.join(work, "end", "frame-%06d.png"));
			vIn.push(`[${idx++}:v]`);
		}
		const voiceIdx = opts.hookVoice ? idx++ : -1;
		if (opts.hookVoice) args.push("-i", opts.hookVoice);

		const norm = vIn.map(
			(l, i) =>
				`${l}fps=${input.fpsRaw},scale=${input.width}:${input.height},setsar=1,format=yuv420p[v${i}]`,
		);
		const filters = [
			...norm,
			`${vIn.map((_, i) => `[v${i}]`).join("")}concat=n=${vIn.length}:v=1:a=0[vout]`,
		];
		const delay = Math.round(openMs);
		const aParts: string[] = [];
		if (input.hasAudio) {
			filters.push(`[${mainIdx}:a]aresample=48000,adelay=${delay}:all=1,apad[amain]`);
			aParts.push("[amain]");
		}
		if (voiceIdx >= 0 && plan.open) {
			filters.push(
				`[${voiceIdx}:a]aresample=48000,adelay=${plan.open.voiceStartMs}:all=1,apad[avoice]`,
			);
			aParts.push("[avoice]");
		}
		const maps = ["-map", "[vout]"];
		if (aParts.length === 1) {
			filters.push(`${aParts[0]}anull[aout]`);
		} else if (aParts.length === 2) {
			filters.push(`${aParts.join("")}amix=inputs=2:duration=longest:normalize=0[aout]`);
		}
		if (aParts.length) maps.push("-map", "[aout]");
		args.push(
			"-filter_complex",
			filters.join(";"),
			...maps,
			"-c:v",
			"libx264",
			"-crf",
			"18",
			"-preset",
			"medium",
			"-pix_fmt",
			"yuv420p",
			"-r",
			input.fpsRaw,
		);
		if (aParts.length) args.push("-c:a", "aac", "-b:a", "192k");
		args.push("-t", totalSec.toFixed(3), "-movflags", "+faststart", opts.out);
		run("ffmpeg", args, "ffmpeg (bookend join)");

		return {
			out: opts.out,
			format,
			inputMs: input.durationMs,
			openMs: Math.round(openMs),
			endMs: Math.round(endMs),
			totalMs: Math.round(totalSec * 1000),
			hookVoiceMs: voiceMs,
			framesRendered: shots,
			plan,
		};
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

function probe2Audio(file: string): number {
	const out = run(
		"ffprobe",
		["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
		"ffprobe (hook voice)",
	);
	const s = Number(out.trim());
	if (!Number.isFinite(s) || s <= 0) throw new BookendError(`cannot read the length of ${file}`);
	return Math.round(s * 1000);
}

export function registerBookendCommand(program: Command): void {
	program
		.command("bookend")
		.description(
			"Add the opening hook (Veil) and the Made with Lensmith end card to a finished film",
		)
		.requiredOption("--in <path>", "finished film (.mp4)")
		.requiredOption("--out <path>", "output film (.mp4)")
		.option("--hook <text>", "hook line shown over the veiled first frame")
		.option("--no-hook", "no opening card")
		.option("--no-end-card", "no Made with Lensmith end card")
		.option("--format <ratio>", "16:9 or 9:16 (default: from the input's aspect)")
		.option(
			"--hook-voice <wav>",
			"spoken hook, mixed at 600 ms (without it the hook holds 2500 ms)",
		)
		.option("--end-card-hold <ms>", "end card hold after the last line lands", "4000")
		.option("--json", "print the result as JSON")
		.action(async (opts: BookendOptions) => {
			try {
				const result = await runBookend(opts);
				if (opts.json) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}
				console.log(`[lensmith bookend] wrote ${result.out}`);
				console.log(
					`opening     ${result.openMs ? `${(Number(result.openMs) / 1000).toFixed(1)} s` : "off"}`,
				);
				console.log(
					`end card    ${result.endMs ? `Made with Lensmith, ${(Number(result.endMs) / 1000).toFixed(1)} s, after the last frame.  Off: --no-end-card` : "off (--no-end-card)"}`,
				);
				console.log(`length      ${(Number(result.totalMs) / 1000).toFixed(3)} s`);
			} catch (err) {
				console.error(`[lensmith bookend] FAILED: ${(err as Error).message}`);
				process.exitCode = 1;
			}
		});
}
