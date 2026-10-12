import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync as realSpawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildFfmpegArgs,
	PACKAGE_PROFILES,
	type PackageDeps,
	resolvePosterTimestamp,
	runPackage,
} from "../src/commands/package.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
// ~11.9s, 2940x1846 — real fixture recording, also used by tests/render.test.ts.
const SHORT_CLIP = path.join(FIXTURES, "recording-1786461836877-clip.mp4");
// ~60.6s, same source resolution — long enough that even the hero profile's
// low bitrate cannot fit under its ceiling; this is the fixture the
// ceiling-exceeded QA scenario (CR Technical Spec item 4) runs against.
const LONG_CLIP = path.join(FIXTURES, "recording-1786461836877.mp4");

// ---------------------------------------------------------------------------
// Pure functions — no process spawning at all.
// ---------------------------------------------------------------------------

describe("buildFfmpegArgs", () => {
	it("scales landscape profiles by target height only, preserving source aspect (scale=-2:H)", () => {
		const args = buildFfmpegArgs(
			PACKAGE_PROFILES.hero,
			{ width: 2940, height: 1846 },
			"in.mp4",
			"out.mp4",
		);
		expect(args).toContain("-vf");
		expect(args[args.indexOf("-vf") + 1]).toBe("scale=-2:720");
		expect(args).toContain("-an"); // hero is muted
		expect(args).not.toContain("-c:a");
	});

	it("embed profile keeps audio and targets 1080", () => {
		const args = buildFfmpegArgs(
			PACKAGE_PROFILES.embed,
			{ width: 1920, height: 1080 },
			"in.mp4",
			"out.mp4",
		);
		expect(args[args.indexOf("-vf") + 1]).toBe("scale=-2:1080");
		expect(args).toContain("-c:a");
		expect(args).toContain("aac");
	});

	it("social profile crops to a centered 9:16 region before scaling to the target width", () => {
		const args = buildFfmpegArgs(
			PACKAGE_PROFILES.social,
			{ width: 2940, height: 1846 },
			"in.mp4",
			"out.mp4",
		);
		const filter = args[args.indexOf("-vf") + 1];
		expect(filter).toMatch(/^crop=\d+:1846:\(in_w-out_w\)\/2:\(in_h-out_h\)\/2,scale=1080:-2$/);
		// crop width must be the 9:16 counterpart of the full source height, clamped even.
		expect(filter).toContain("crop=1038:1846");
	});

	it("bounds the encode bitrate with -maxrate/-bufsize derived from the profile, not a magic literal", () => {
		const args = buildFfmpegArgs(
			PACKAGE_PROFILES.hero,
			{ width: 1920, height: 1080 },
			"in.mp4",
			"out.mp4",
		);
		expect(args[args.indexOf("-b:v") + 1]).toBe("1500000");
		expect(args[args.indexOf("-maxrate") + 1]).toBe("1500000");
		expect(args[args.indexOf("-bufsize") + 1]).toBe("3000000");
	});
});

describe("resolvePosterTimestamp", () => {
	it("uses the profile's documented timestamp when the clip is long enough", () => {
		expect(resolvePosterTimestamp(PACKAGE_PROFILES.hero, 12)).toBe(0.5);
	});

	it("clamps to just before the end of a clip shorter than the documented timestamp", () => {
		expect(resolvePosterTimestamp(PACKAGE_PROFILES.hero, 0.2)).toBeCloseTo(0.15);
	});

	it("never goes negative for a zero-duration clip", () => {
		expect(resolvePosterTimestamp(PACKAGE_PROFILES.hero, 0)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Orchestration — fake spawnSync, no real ffmpeg/ffprobe. Mirrors the
// tests/caption.test.ts pattern: proves error handling and the ceiling gate
// without depending on real binaries or real render time.
// ---------------------------------------------------------------------------

function fakeDeps(opts: {
	ffmpegAvailable?: boolean;
	ffprobeAvailable?: boolean;
	sourceProbe?: { width: number; height: number; duration: string };
	encodedProbe?: { width: number; height: number; duration: string };
	encodeFails?: boolean;
	posterFails?: boolean;
	/** Bytes to write for the "encoded" video file — drives the ceiling check. */
	encodedBytes?: number;
}): PackageDeps {
	const {
		ffmpegAvailable = true,
		ffprobeAvailable = true,
		sourceProbe = { width: 2940, height: 1846, duration: "11.9" },
		encodedProbe = { width: 1280, height: 804, duration: "11.9" },
		encodeFails = false,
		posterFails = false,
		encodedBytes = 2_000_000,
	} = opts;

	let probeCallCount = 0;

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
		error: Object.assign(new Error("spawnSync ENOENT"), { code: "ENOENT" }),
	});

	const fake = (cmd: string, args: readonly string[] = []): SpawnSyncReturns<Buffer> => {
		if (cmd === "ffmpeg" && args[0] === "-version") {
			return ffmpegAvailable ? ok() : notFound();
		}
		if (cmd === "ffprobe" && args[0] === "-version") {
			return ffprobeAvailable ? ok() : notFound();
		}
		if (cmd === "ffprobe") {
			probeCallCount += 1;
			const p = probeCallCount === 1 ? sourceProbe : encodedProbe;
			return ok(
				JSON.stringify({
					streams: [{ width: p.width, height: p.height }],
					format: { duration: p.duration },
				}),
			);
		}
		if (cmd === "ffmpeg" && args.includes("-frames:v")) {
			if (posterFails) return fail("ffmpeg: poster boom");
			writeFileSync(args[args.length - 1] as string, "fake poster png");
			return ok();
		}
		if (cmd === "ffmpeg") {
			if (encodeFails) return fail("ffmpeg: encode boom");
			writeFileSync(args[args.length - 1] as string, Buffer.alloc(encodedBytes, 1));
			return ok();
		}
		throw new Error(`fakeDeps: unexpected command ${cmd} ${args.join(" ")}`);
	};

	return { spawnSync: fake as unknown as PackageDeps["spawnSync"] };
}

describe("runPackage (orchestration, fake spawnSync)", () => {
	const tmpDirs: string[] = [];
	const inputVideo = path.join(tmpdir(), "lensmith-package-test-input.mp4");

	function tmpOutDir(): string {
		const d = mkdtempSync(path.join(tmpdir(), "lensmith-package-test-"));
		tmpDirs.push(d);
		return d;
	}

	writeFileSync(inputVideo, "not a real video, just needs to exist for the existsSync check");

	afterEach(() => {
		for (const d of tmpDirs.splice(0)) {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("returns code 1 with a clear message when --in does not exist", () => {
		const result = runPackage(
			{ in: "/tmp/lensmith-package-does-not-exist.mp4", outDir: tmpOutDir(), profile: "hero" },
			fakeDeps({}),
		);
		expect(result.code).toBe(1);
		expect(result.outputs).toEqual([]);
	});

	it("returns code 1 and lists valid profile names for an unknown --profile", () => {
		const result = runPackage(
			{ in: inputVideo, outDir: tmpOutDir(), profile: "bogus" },
			fakeDeps({}),
		);
		expect(result.code).toBe(1);
		expect(result.outputs).toEqual([]);
	});

	it("returns code 1 when ffmpeg is not on PATH", () => {
		const result = runPackage(
			{ in: inputVideo, outDir: tmpOutDir(), profile: "hero" },
			fakeDeps({ ffmpegAvailable: false }),
		);
		expect(result.code).toBe(1);
	});

	it("returns code 1 when ffprobe is not on PATH", () => {
		const result = runPackage(
			{ in: inputVideo, outDir: tmpOutDir(), profile: "hero" },
			fakeDeps({ ffprobeAvailable: false }),
		);
		expect(result.code).toBe(1);
	});

	it("returns code 1 when the ffmpeg encode step fails", () => {
		const result = runPackage(
			{ in: inputVideo, outDir: tmpOutDir(), profile: "hero" },
			fakeDeps({ encodeFails: true }),
		);
		expect(result.code).toBe(1);
	});

	it("happy path: produces a video + poster output pair, both under the ceiling", () => {
		const outDir = tmpOutDir();
		const result = runPackage(
			{ in: inputVideo, outDir, profile: "hero" },
			fakeDeps({ encodedBytes: 2_000_000 }),
		);
		expect(result.code).toBe(0);
		expect(result.outputs).toHaveLength(2);
		const [video, poster] = result.outputs;
		expect(video.kind).toBe("video");
		expect(video.bytes).toBe(2_000_000);
		expect(video.durationSeconds).toBeCloseTo(11.9);
		expect(poster.kind).toBe("poster");
		expect(existsSync(video.path)).toBe(true);
		expect(existsSync(poster.path)).toBe(true);
		expect(path.basename(video.path, ".mp4")).toBe(path.basename(poster.path, ".png"));
	});

	it("a ceiling-exceeding encode returns code 1 and names the profile's ceiling and the actual size (not a silent pass)", () => {
		const outDir = tmpOutDir();
		// hero's ceiling is 3_000_000 bytes; simulate an encode that overshoots it.
		const result = runPackage(
			{ in: inputVideo, outDir, profile: "hero" },
			fakeDeps({ encodedBytes: 5_000_000 }),
		);
		expect(result.code).toBe(1);
		expect(result.ceilingViolation).toEqual({
			profile: "hero",
			maxBytes: PACKAGE_PROFILES.hero.maxBytes,
			actualBytes: 5_000_000,
		});
		// the video+poster were still produced — only the ceiling gate failed after the fact.
		expect(result.outputs).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Real end-to-end — actual ffmpeg/ffprobe, actual repo fixtures. Skips
// cleanly (never silently) if the tools aren't on PATH, mirroring
// tests/render.test.ts / tests/caption.test.ts's own guard for environments
// without ffmpeg (e.g. GitHub-hosted macos-latest runners, confirmed absent
// there in the CR-LENSMITH-A001-4 forge report).
// ---------------------------------------------------------------------------

function hasBinary(cmd: string): boolean {
	const result = realSpawnSync(cmd, ["-version"], { encoding: "utf-8" });
	return !result.error && result.status === 0;
}

const ffmpegPresent = hasBinary("ffmpeg") && hasBinary("ffprobe");
const describeReal = ffmpegPresent ? describe : describe.skip;

describeReal("runPackage (real ffmpeg, real fixtures)", () => {
	const tmpDirs: string[] = [];

	function tmpOutDir(): string {
		const d = mkdtempSync(path.join(tmpdir(), "lensmith-package-e2e-"));
		tmpDirs.push(d);
		return d;
	}

	afterEach(() => {
		for (const d of tmpDirs.splice(0)) {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("hero profile against the real ~12s clip: real MP4 under ceiling + real poster PNG, dimensions/duration/size reported", () => {
		const outDir = tmpOutDir();
		const result = runPackage({ in: SHORT_CLIP, outDir, profile: "hero" });

		expect(result.code).toBe(0);
		expect(result.outputs).toHaveLength(2);
		const [video, poster] = result.outputs;

		expect(video.kind).toBe("video");
		expect(existsSync(video.path)).toBe(true);
		expect(statSync(video.path).size).toBe(video.bytes);
		expect(video.bytes).toBeLessThanOrEqual(PACKAGE_PROFILES.hero.maxBytes);
		expect(video.height).toBe(720); // hero targets 720p-class height exactly
		expect(video.width).toBeGreaterThan(0);
		expect(video.durationSeconds).toBeGreaterThan(10);
		expect(video.durationSeconds).toBeLessThan(13);

		expect(poster.kind).toBe("poster");
		expect(existsSync(poster.path)).toBe(true);
		expect(statSync(poster.path).size).toBe(poster.bytes);
		expect(poster.bytes).toBeGreaterThan(0);
		expect(path.basename(video.path, ".mp4")).toBe(path.basename(poster.path, ".png"));
	}, 60_000);

	it("social profile against the real ~12s clip: real vertical-crop output at the declared width", () => {
		const outDir = tmpOutDir();
		const result = runPackage({ in: SHORT_CLIP, outDir, profile: "social" });

		expect(result.code).toBe(0);
		const [video] = result.outputs;
		expect(video.width).toBe(1080);
		expect(video.height).toBeGreaterThan(video.width); // portrait
		expect(video.bytes).toBeLessThanOrEqual(PACKAGE_PROFILES.social.maxBytes);
	}, 60_000);

	it("hero profile against the real ~60s clip cannot meet the hero ceiling: non-zero exit naming the ceiling and the actual size", () => {
		const outDir = tmpOutDir();
		const result = runPackage({ in: LONG_CLIP, outDir, profile: "hero" });

		expect(result.code).toBe(1);
		expect(result.ceilingViolation).toBeDefined();
		expect(result.ceilingViolation?.profile).toBe("hero");
		expect(result.ceilingViolation?.maxBytes).toBe(PACKAGE_PROFILES.hero.maxBytes);
		expect(result.ceilingViolation?.actualBytes).toBeGreaterThan(PACKAGE_PROFILES.hero.maxBytes);
		// the encode still ran and produced real files — the gate is a post-hoc check, not a refusal to build.
		expect(result.outputs).toHaveLength(2);
		expect(existsSync(result.outputs[0].path)).toBe(true);
	}, 120_000);
});
