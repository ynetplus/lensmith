import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";

/**
 * `lensmith package` — role 10 of the director pipeline LOCK (the
 * export-profile packager, `lensmith-director-pipeline-standard-v1.md`
 * row 10). Turns one already-rendered MP4 (the output of `lensmith
 * process`, role 7) into a named, embed-ready variant plus a poster
 * frame, using ffmpeg (already `in-use`, same tool `caption.ts` shells
 * out to). This command only reads a finished render and writes new
 * files beside it — `process`'s own output is untouched.
 */

/** A profile is a declarative record, never a scattered ffmpeg string. */
export interface PackageProfile {
	readonly name: string;
	readonly description: string;
	/** Scale target: landscape profiles pin height, `crop` profiles pin width after a 9:16 crop. */
	readonly targetHeight?: number;
	readonly targetWidth?: number;
	readonly crop?: "vertical-9x16";
	readonly videoBitrateBps: number;
	readonly audio: boolean;
	readonly audioBitrateBps?: number;
	readonly container: "mp4";
	readonly pixelFormat: "yuv420p";
	/** Documented poster-frame timestamp, seconds from the start of the OUTPUT clip. */
	readonly posterAtSeconds: number;
	/** Size ceiling in bytes — exceeding it silently would not be a profile. */
	readonly maxBytes: number;
}

export const PACKAGE_PROFILES: Record<string, PackageProfile> = {
	hero: {
		name: "hero",
		description: "short autoplay loop for a hero slot — muted, low bitrate, 720p-class",
		targetHeight: 720,
		videoBitrateBps: 1_500_000,
		audio: false,
		container: "mp4",
		pixelFormat: "yuv420p",
		posterAtSeconds: 0.5,
		maxBytes: 3_000_000,
	},
	embed: {
		name: "embed",
		description: "in-page player — 1080p, moderate bitrate, audio kept",
		targetHeight: 1080,
		videoBitrateBps: 6_000_000,
		audio: true,
		audioBitrateBps: 128_000,
		container: "mp4",
		pixelFormat: "yuv420p",
		posterAtSeconds: 0.5,
		maxBytes: 20_000_000,
	},
	social: {
		name: "social",
		description: "vertical crop for reels — center 9:16 crop, audio kept",
		targetWidth: 1080,
		crop: "vertical-9x16",
		videoBitrateBps: 4_000_000,
		audio: true,
		audioBitrateBps: 128_000,
		container: "mp4",
		pixelFormat: "yuv420p",
		posterAtSeconds: 0.5,
		maxBytes: 15_000_000,
	},
};

export interface PackageOptions {
	in: string;
	outDir: string;
	profile: string;
}

export interface PackagedOutput {
	kind: "video" | "poster";
	path: string;
	width: number;
	height: number;
	/** Seconds — omitted for a poster, which has no duration. */
	durationSeconds?: number;
	bytes: number;
}

export interface PackageResult {
	code: number;
	outputs: PackagedOutput[];
	/** Set only when the ceiling was exceeded — the profile name and the actual/ceiling bytes. */
	ceilingViolation?: { profile: string; maxBytes: number; actualBytes: number };
}

/** Injectable subset of node APIs so the orchestration is unit-testable without real binaries. */
export interface PackageDeps {
	spawnSync: typeof spawnSync;
}

const realDeps: PackageDeps = { spawnSync };

export function registerPackageCommand(program: Command): void {
	program
		.command("package")
		.description("Package a rendered MP4 into an embed-ready variant plus a poster frame")
		.requiredOption("--in <path>", "rendered video to package (.mp4)")
		.requiredOption("--out-dir <dir>", "directory to write the variant + poster into")
		.requiredOption(
			"--profile <name>",
			`built-in profile: ${Object.keys(PACKAGE_PROFILES).join(", ")}`,
		)
		.action((opts: { in: string; outDir: string; profile: string }) => {
			const result = runPackage(opts, realDeps);
			if (result.code !== 0) {
				process.exitCode = result.code;
			}
		});
}

function commandAvailable(deps: PackageDeps, cmd: string): boolean {
	const result = deps.spawnSync(cmd, ["-version"], { stdio: "ignore" });
	return !result.error;
}

class PackageError extends Error {}

function runOrThrow(
	deps: PackageDeps,
	cmd: string,
	args: string[],
	label: string,
): SpawnSyncReturns<Buffer> {
	const result = deps.spawnSync(cmd, args, { encoding: "buffer" });
	if (result.error) {
		const code = (result.error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new PackageError(
				`${label} not found on PATH ('${cmd}'). Install it before running 'lensmith package'.`,
			);
		}
		throw new PackageError(`${label} failed to start: ${result.error.message}`);
	}
	if (result.status !== 0) {
		const stderr = result.stderr?.toString("utf-8").trim();
		throw new PackageError(
			`${label} exited with code ${result.status}.${stderr ? `\n${stderr}` : ""}`,
		);
	}
	return result;
}

interface Probe {
	width: number;
	height: number;
	durationSeconds: number;
}

/** Probes a video's width/height/duration via `ffprobe`. */
function probe(deps: PackageDeps, filePath: string): Probe {
	const result = runOrThrow(
		deps,
		"ffprobe",
		[
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=width,height",
			"-show_entries",
			"format=duration",
			"-of",
			"json",
			filePath,
		],
		"ffprobe",
	);
	const parsed = JSON.parse(result.stdout.toString("utf-8")) as {
		streams?: { width?: number; height?: number }[];
		format?: { duration?: string };
	};
	const stream = parsed.streams?.[0];
	if (!stream?.width || !stream?.height || !parsed.format?.duration) {
		throw new PackageError(`ffprobe returned no usable stream info for ${filePath}`);
	}
	return {
		width: stream.width,
		height: stream.height,
		durationSeconds: Number.parseFloat(parsed.format.duration),
	};
}

/** Builds the ffmpeg filter + encode args for a profile against a known source size — no scattered strings, one profile's declarative record in, one filtergraph out. */
export function buildFfmpegArgs(
	profile: PackageProfile,
	source: { width: number; height: number },
	inPath: string,
	outPath: string,
): string[] {
	let filter: string;
	if (profile.crop === "vertical-9x16") {
		const cropWidth = Math.round((source.height * (9 / 16)) / 2) * 2;
		const cropHeight = source.height % 2 === 0 ? source.height : source.height - 1;
		const targetWidth = profile.targetWidth ?? cropWidth;
		filter = `crop=${Math.min(cropWidth, source.width)}:${cropHeight}:(in_w-out_w)/2:(in_h-out_h)/2,scale=${targetWidth}:-2`;
	} else {
		filter = `scale=-2:${profile.targetHeight}`;
	}

	const args = [
		"-y",
		"-i",
		inPath,
		"-vf",
		filter,
		"-c:v",
		"libx264",
		"-b:v",
		String(profile.videoBitrateBps),
		"-maxrate",
		String(profile.videoBitrateBps),
		"-bufsize",
		String(profile.videoBitrateBps * 2),
		"-pix_fmt",
		profile.pixelFormat,
		"-movflags",
		"+faststart",
	];

	if (profile.audio) {
		args.push("-c:a", "aac", "-b:a", String(profile.audioBitrateBps ?? 128_000));
	} else {
		args.push("-an");
	}

	args.push(outPath);
	return args;
}

/** Clamps the documented poster timestamp to a real moment inside a clip that may be shorter than it. */
export function resolvePosterTimestamp(profile: PackageProfile, durationSeconds: number): number {
	if (durationSeconds <= 0) return 0;
	return Math.min(profile.posterAtSeconds, Math.max(durationSeconds - 0.05, 0));
}

function formatOutputLine(profile: string, output: PackagedOutput): string {
	const dims = `${output.width}x${output.height}`;
	const duration =
		output.durationSeconds !== undefined ? `, ${output.durationSeconds.toFixed(2)}s` : "";
	return `[lensmith package] ${profile} ${output.kind}: ${output.path} (${dims}${duration}, ${output.bytes} bytes)`;
}

/**
 * Runs the full package pipeline. Returns a result carrying every produced
 * output and its measured stats. Exported for direct unit testing (see
 * tests/package.test.ts) — the CLI `action` handler above is a thin wrapper.
 */
export function runPackage(opts: PackageOptions, deps: PackageDeps = realDeps): PackageResult {
	if (!existsSync(opts.in)) {
		console.error(`Error: input video not found: ${opts.in}`);
		return { code: 1, outputs: [] };
	}

	const profile = PACKAGE_PROFILES[opts.profile];
	if (!profile) {
		console.error(
			`Error: unknown --profile "${opts.profile}". Valid profiles: ${Object.keys(PACKAGE_PROFILES).join(", ")}.`,
		);
		return { code: 1, outputs: [] };
	}

	try {
		if (!commandAvailable(deps, "ffmpeg")) {
			throw new PackageError(
				"ffmpeg not found on PATH. Install it before running 'lensmith package'.",
			);
		}
		if (!commandAvailable(deps, "ffprobe")) {
			throw new PackageError(
				"ffprobe not found on PATH. Install it before running 'lensmith package'.",
			);
		}

		mkdirSync(opts.outDir, { recursive: true });

		const stem = `${path.basename(opts.in, path.extname(opts.in))}-${profile.name}`;
		const videoOutPath = path.join(opts.outDir, `${stem}.mp4`);
		const posterOutPath = path.join(opts.outDir, `${stem}.png`);

		const source = probe(deps, opts.in);
		const ffmpegArgs = buildFfmpegArgs(profile, source, opts.in, videoOutPath);
		runOrThrow(deps, "ffmpeg", ffmpegArgs, "ffmpeg (package encode)");

		const encoded = probe(deps, videoOutPath);
		const videoBytes = statSync(videoOutPath).size;
		const videoOutput: PackagedOutput = {
			kind: "video",
			path: videoOutPath,
			width: encoded.width,
			height: encoded.height,
			durationSeconds: encoded.durationSeconds,
			bytes: videoBytes,
		};

		const posterAt = resolvePosterTimestamp(profile, encoded.durationSeconds);
		runOrThrow(
			deps,
			"ffmpeg",
			[
				"-y",
				"-ss",
				posterAt.toFixed(3),
				"-i",
				videoOutPath,
				"-frames:v",
				"1",
				"-q:v",
				"2",
				posterOutPath,
			],
			"ffmpeg (poster frame)",
		);
		const posterBytes = statSync(posterOutPath).size;
		const posterOutput: PackagedOutput = {
			kind: "poster",
			path: posterOutPath,
			width: encoded.width,
			height: encoded.height,
			bytes: posterBytes,
		};

		const outputs = [videoOutput, posterOutput];
		for (const output of outputs) {
			console.log(formatOutputLine(profile.name, output));
		}

		if (videoBytes > profile.maxBytes) {
			console.error(
				`Error: ${profile.name} output exceeds its ${profile.maxBytes}-byte ceiling: ${videoOutPath} is ${videoBytes} bytes.`,
			);
			return {
				code: 1,
				outputs,
				ceilingViolation: {
					profile: profile.name,
					maxBytes: profile.maxBytes,
					actualBytes: videoBytes,
				},
			};
		}

		return { code: 0, outputs };
	} catch (err) {
		const message = err instanceof PackageError ? err.message : (err as Error).message;
		console.error(`Error: ${message}`);
		return { code: 1, outputs: [] };
	}
}
