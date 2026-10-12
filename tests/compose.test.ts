import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPOSE_DEFAULTS, runCompose, validateZoomFragment } from "../src/commands/compose.js";

// Coverage for `lensmith compose` (CR-LENSMITH-A001-8) — the joint between
// `suggest-zooms` (which emits a `{ zoomRegions: [...] }` fragment) and
// `process` (which demands a whole EditorProjectData project file).
//
// The load-bearing test here is the ROUND-TRIP one: composing the fixture's
// OWN zoomRegions must reproduce the fixture's `editor` object exactly, field
// for field. The fixture is a real project saved by OpenScreen's GUI, so a
// zero-difference round trip is the only honest proof that this command emits
// the real schema rather than a plausible-looking imitation of it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, "..", "dist", "cli.js");
const FIXTURES = path.join(__dirname, "fixtures");
const FIXTURE_PROJECT = path.join(FIXTURES, "recording-1786461836877.openscreen");
const NO_ZOOM_PROJECT = path.join(FIXTURES, "recording-1786461836877-no-zoom.openscreen");
const RAW_CLIP = path.join(FIXTURES, "recording-1786461836877-clip.mp4");

function runCli(args: string[]) {
	return spawnSync("node", [CLI_PATH, ...args], { encoding: "utf-8" });
}

function readFixture(filePath: string) {
	return JSON.parse(readFileSync(filePath, "utf-8"));
}

/** Deep field-by-field diff, returning dotted paths whose values differ. */
function diffFields(a: unknown, b: unknown, prefix = ""): string[] {
	if (JSON.stringify(a) === JSON.stringify(b)) return [];
	const bothObjects =
		typeof a === "object" &&
		a !== null &&
		typeof b === "object" &&
		b !== null &&
		Array.isArray(a) === Array.isArray(b);
	if (!bothObjects) return [prefix || "(root)"];

	const keys = new Set([
		...Object.keys(a as Record<string, unknown>),
		...Object.keys(b as Record<string, unknown>),
	]);
	const differences: string[] = [];
	for (const key of keys) {
		differences.push(
			...diffFields(
				(a as Record<string, unknown>)[key],
				(b as Record<string, unknown>)[key],
				prefix ? `${prefix}.${key}` : key,
			),
		);
	}
	return differences;
}

describe("compose — round-trip fidelity against the real GUI-saved fixture", () => {
	let tmpDir: string;

	afterEach(() => {
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	it("composing the fixture's own zoomRegions reproduces its `editor` object with ZERO differing fields", () => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "lensmith-compose-"));
		const fixture = readFixture(FIXTURE_PROJECT);
		const zoomsPath = path.join(tmpDir, "zooms.json");
		writeFileSync(zoomsPath, JSON.stringify({ zoomRegions: fixture.editor.zoomRegions }), "utf-8");

		const composed = runCompose({ zoomsPath, rawPath: RAW_CLIP });

		const differences = diffFields(composed.editor, fixture.editor);
		expect(differences).toEqual([]);
		// Key ORDER too — the fixture is the schema, and a reordered project
		// file is a needless diff for anyone comparing them by eye.
		expect(Object.keys(composed.editor)).toEqual(Object.keys(fixture.editor));
	});

	it("reproduces the no-zoom fixture's `editor` exactly for an empty fragment", () => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "lensmith-compose-"));
		const fixture = readFixture(NO_ZOOM_PROJECT);
		const zoomsPath = path.join(tmpDir, "zooms.json");
		writeFileSync(zoomsPath, JSON.stringify({ zoomRegions: [] }), "utf-8");

		const composed = runCompose({ zoomsPath, rawPath: RAW_CLIP });

		expect(diffFields(composed.editor, fixture.editor)).toEqual([]);
	});

	it("emits the fixture's top-level shape: version 2 + media.cursorCaptureMode", () => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "lensmith-compose-"));
		const fixture = readFixture(FIXTURE_PROJECT);
		const zoomsPath = path.join(tmpDir, "zooms.json");
		writeFileSync(zoomsPath, JSON.stringify({ zoomRegions: [] }), "utf-8");

		const composed = runCompose({ zoomsPath, rawPath: RAW_CLIP });

		expect(composed.version).toBe(fixture.version);
		expect(composed.media.cursorCaptureMode).toBe(fixture.media.cursorCaptureMode);
		expect(Object.keys(composed.media)).toEqual(Object.keys(fixture.media));
	});

	it("writes --raw verbatim into media.screenVideoPath (the render path never reads it — see CR §2)", () => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "lensmith-compose-"));
		const zoomsPath = path.join(tmpDir, "zooms.json");
		writeFileSync(zoomsPath, JSON.stringify({ zoomRegions: [] }), "utf-8");

		const composed = runCompose({ zoomsPath, rawPath: "./relative/clip.mp4" });

		expect(composed.media.screenVideoPath).toBe("./relative/clip.mp4");
	});

	it("passes zoom regions through verbatim — no field is dropped or rewritten", () => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "lensmith-compose-"));
		const fixture = readFixture(FIXTURE_PROJECT);
		const zoomsPath = path.join(tmpDir, "zooms.json");
		writeFileSync(zoomsPath, JSON.stringify({ zoomRegions: fixture.editor.zoomRegions }), "utf-8");

		const composed = runCompose({ zoomsPath, rawPath: RAW_CLIP });

		expect(composed.editor.zoomRegions).toEqual(fixture.editor.zoomRegions);
	});
});

describe("compose — presentation flags", () => {
	let tmpDir: string;

	afterEach(() => {
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	function composeWith(overrides: Record<string, unknown>) {
		tmpDir = mkdtempSync(path.join(tmpdir(), "lensmith-compose-"));
		const zoomsPath = path.join(tmpDir, "zooms.json");
		writeFileSync(zoomsPath, JSON.stringify({ zoomRegions: [] }), "utf-8");
		return runCompose({ zoomsPath, rawPath: RAW_CLIP, ...overrides });
	}

	it("defaults match the fixture's own values", () => {
		const fixture = readFixture(FIXTURE_PROJECT);
		expect(COMPOSE_DEFAULTS.aspectRatio).toBe(fixture.editor.aspectRatio);
		expect(COMPOSE_DEFAULTS.exportQuality).toBe(fixture.editor.exportQuality);
		expect(COMPOSE_DEFAULTS.padding).toBe(fixture.editor.padding);
		expect(COMPOSE_DEFAULTS.wallpaper).toBe(fixture.editor.wallpaper);
		expect(COMPOSE_DEFAULTS.borderRadius).toBe(fixture.editor.borderRadius);
		expect(COMPOSE_DEFAULTS.shadowIntensity).toBe(fixture.editor.shadowIntensity);
	});

	it("each flag lands on its own editor field and disturbs nothing else", () => {
		const composed = composeWith({
			aspectRatio: "9:16",
			exportQuality: "source",
			padding: 12,
			wallpaper: "/wallpapers/wallpaper4.jpg",
			borderRadius: 24,
			shadowIntensity: 60,
		});

		expect(composed.editor.aspectRatio).toBe("9:16");
		expect(composed.editor.exportQuality).toBe("source");
		expect(composed.editor.padding).toBe(12);
		expect(composed.editor.wallpaper).toBe("/wallpapers/wallpaper4.jpg");
		expect(composed.editor.borderRadius).toBe(24);
		expect(composed.editor.shadowIntensity).toBe(60);
		// Untouched by any flag:
		expect(composed.editor.cropRegion).toEqual({ x: 0, y: 0, width: 1, height: 1 });
		expect(composed.editor.exportFormat).toBe("mp4");
	});
});

describe("compose — fragment validation (never write a broken project)", () => {
	const validRegion = {
		id: "zoom-1",
		startMs: 0,
		endMs: 1000,
		depth: 3,
		customScale: 1.8,
		focus: { cx: 0.5, cy: 0.5 },
		source: "auto",
	};

	it("accepts a well-formed fragment", () => {
		expect(validateZoomFragment({ zoomRegions: [validRegion] }, "z.json")).toHaveLength(1);
	});

	it("BF-13: defaults a missing depth/customScale/source and warns once per field", () => {
		const writes: string[] = [];
		const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		});
		let out: ReturnType<typeof validateZoomFragment>;
		try {
			const { depth: _d, customScale: _c, source: _s, ...bare } = validRegion;
			out = validateZoomFragment({ zoomRegions: [bare] }, "z.json");
		} finally {
			spy.mockRestore();
		}
		expect(out[0]).toMatchObject({ depth: 3, customScale: 1.8, source: "auto" });
		expect(writes).toEqual([
			"compose: zoom region zoom-1 had no depth, using 3\n",
			"compose: zoom region zoom-1 had no customScale, using 1.8\n",
		]);
	});

	it("BF-13: leaves present depth/customScale untouched and silent", () => {
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const out = validateZoomFragment(
				{ zoomRegions: [{ ...validRegion, depth: 5, customScale: 2.5 }] },
				"z.json",
			);
			expect(out[0]).toMatchObject({ depth: 5, customScale: 2.5 });
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("BF-13: rejects a non-numeric depth or customScale, naming the region id", () => {
		expect(() =>
			validateZoomFragment({ zoomRegions: [{ ...validRegion, depth: "deep" }] }, "z.json"),
		).toThrow(/zoom-1.*depth/);
		expect(() =>
			validateZoomFragment({ zoomRegions: [{ ...validRegion, customScale: "big" }] }, "z.json"),
		).toThrow(/zoom-1.*customScale/);
	});

	it("accepts an empty zoomRegions array (a valid no-zoom project)", () => {
		expect(validateZoomFragment({ zoomRegions: [] }, "z.json")).toEqual([]);
	});

	it("rejects a fragment that is not an object with zoomRegions", () => {
		expect(() => validateZoomFragment([1, 2, 3], "z.json")).toThrow(/zoomRegions/);
		expect(() => validateZoomFragment({ regions: [] }, "z.json")).toThrow(/zoomRegions/);
	});

	it("rejects startMs >= endMs, naming the offending region", () => {
		expect(() =>
			validateZoomFragment(
				{ zoomRegions: [{ ...validRegion, id: "bad-region", startMs: 5000, endMs: 1000 }] },
				"z.json",
			),
		).toThrow(/"bad-region".*startMs >= endMs/s);
	});

	it("rejects a zero-length region (startMs === endMs)", () => {
		expect(() =>
			validateZoomFragment(
				{ zoomRegions: [{ ...validRegion, startMs: 1000, endMs: 1000 }] },
				"z.json",
			),
		).toThrow(/startMs >= endMs/);
	});

	it("rejects focus outside 0..1, naming the axis and the region", () => {
		expect(() =>
			validateZoomFragment(
				{ zoomRegions: [{ ...validRegion, id: "off-screen", focus: { cx: 1.4, cy: 0.5 } }] },
				"z.json",
			),
		).toThrow(/"off-screen".*focus\.cx/s);
		expect(() =>
			validateZoomFragment(
				{ zoomRegions: [{ ...validRegion, focus: { cx: 0.5, cy: -0.1 } }] },
				"z.json",
			),
		).toThrow(/focus\.cy/);
	});

	it("rejects a missing or empty id, falling back to the index in the message", () => {
		expect(() =>
			validateZoomFragment({ zoomRegions: [{ ...validRegion, id: "" }] }, "z.json"),
		).toThrow(/at index 0.*"id"/s);
	});

	it("rejects non-numeric timings and a missing focus object", () => {
		expect(() =>
			validateZoomFragment({ zoomRegions: [{ ...validRegion, endMs: "later" }] }, "z.json"),
		).toThrow(/startMs.*endMs/s);
		expect(() =>
			validateZoomFragment({ zoomRegions: [{ ...validRegion, focus: undefined }] }, "z.json"),
		).toThrow(/focus/);
	});

	it("names the SECOND region when it is the broken one", () => {
		expect(() =>
			validateZoomFragment(
				{ zoomRegions: [validRegion, { ...validRegion, id: "second", startMs: 9, endMs: 8 }] },
				"z.json",
			),
		).toThrow(/"second" \(index 1\)/);
	});
});

describe("compose — built CLI surface", () => {
	let tmpDir: string;

	afterEach(() => {
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	it("--help exits 0 and documents every flag from the Technical Spec", () => {
		const result = runCli(["compose", "--help"]);
		expect(result.status).toBe(0);
		for (const flag of [
			"--zooms",
			"--raw",
			"--out",
			"--aspect",
			"--quality",
			"--padding",
			"--wallpaper",
			"--border-radius",
			"--shadow-intensity",
		]) {
			expect(result.stdout).toContain(flag);
		}
	});

	it("missing required options fails with a non-zero exit (not a crash)", () => {
		const result = runCli(["compose"]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("required option");
	});

	it("real suggest-zooms output -> a project file `process` accepts", () => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "lensmith-compose-cli-"));
		const zoomsPath = path.join(tmpDir, "zooms.json");
		const outPath = path.join(tmpDir, "project.openscreen");

		const suggested = runCli([
			"suggest-zooms",
			"--cursor",
			path.join(FIXTURES, "recording-1786461836877.mp4.cursor.json"),
			"--duration-ms",
			"11896",
			"--out",
			zoomsPath,
		]);
		expect(suggested.status).toBe(0);

		const composed = runCli(["compose", "--zooms", zoomsPath, "--raw", RAW_CLIP, "--out", outPath]);
		expect(composed.status).toBe(0);
		expect(composed.stdout).toContain("zoom region(s)");

		const project = readFixture(outPath);
		const fixture = readFixture(FIXTURE_PROJECT);
		// Same schema as the GUI-saved project, only the regions differ.
		expect(Object.keys(project.editor)).toEqual(Object.keys(fixture.editor));
		expect(project.editor.zoomRegions.length).toBeGreaterThan(0);
		for (const region of project.editor.zoomRegions) {
			expect(region.startMs).toBeLessThan(region.endMs);
		}
	});

	it("a malformed region fails with a clear error AND writes no output file", () => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "lensmith-compose-cli-"));
		const zoomsPath = path.join(tmpDir, "zooms.json");
		const outPath = path.join(tmpDir, "project.openscreen");
		writeFileSync(
			zoomsPath,
			JSON.stringify({
				zoomRegions: [
					{ id: "broken", startMs: 9000, endMs: 1000, depth: 3, focus: { cx: 0.5, cy: 0.5 } },
				],
			}),
			"utf-8",
		);

		const result = runCli(["compose", "--zooms", zoomsPath, "--raw", RAW_CLIP, "--out", outPath]);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("broken");
		expect(result.stderr).toContain("startMs >= endMs");
		expect(existsSync(outPath)).toBe(false);
	});

	it("a non-JSON --zooms file fails clearly with exit 1", () => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "lensmith-compose-cli-"));
		const zoomsPath = path.join(tmpDir, "not-json.txt");
		const outPath = path.join(tmpDir, "project.openscreen");
		writeFileSync(zoomsPath, "this is not JSON at all", "utf-8");

		const result = runCli(["compose", "--zooms", zoomsPath, "--raw", RAW_CLIP, "--out", outPath]);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("is not valid JSON");
		expect(existsSync(outPath)).toBe(false);
	});

	it("a missing --zooms file fails clearly, not with a crash", () => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "lensmith-compose-cli-"));
		const outPath = path.join(tmpDir, "project.openscreen");

		const result = runCli([
			"compose",
			"--zooms",
			path.join(tmpDir, "does-not-exist.json"),
			"--raw",
			RAW_CLIP,
			"--out",
			outPath,
		]);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("could not read --zooms file");
		expect(existsSync(outPath)).toBe(false);
	});

	it("rejects an unknown --aspect / --quality instead of writing an unrenderable project", () => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "lensmith-compose-cli-"));
		const zoomsPath = path.join(tmpDir, "zooms.json");
		const outPath = path.join(tmpDir, "project.openscreen");
		writeFileSync(zoomsPath, JSON.stringify({ zoomRegions: [] }), "utf-8");

		const badAspect = runCli([
			"compose",
			"--zooms",
			zoomsPath,
			"--raw",
			RAW_CLIP,
			"--out",
			outPath,
			"--aspect",
			"21:9",
		]);
		expect(badAspect.status).toBe(1);
		expect(badAspect.stderr).toContain("--aspect must be one of");

		const badQuality = runCli([
			"compose",
			"--zooms",
			zoomsPath,
			"--raw",
			RAW_CLIP,
			"--out",
			outPath,
			"--quality",
			"ultra",
		]);
		expect(badQuality.status).toBe(1);
		expect(badQuality.stderr).toContain("--quality must be one of");
		expect(existsSync(outPath)).toBe(false);
	});
});
