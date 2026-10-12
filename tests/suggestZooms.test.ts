import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runSuggestZooms } from "../src/commands/suggestZooms.js";
import { buildAutoZoomSuggestions, type CursorTelemetryPoint } from "../src/lib/zoomSuggestion.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_61836877 = path.join(
	__dirname,
	"fixtures",
	"recording-1786461836877.mp4.cursor.json",
);
const FIXTURE_58256937 = path.join(
	__dirname,
	"fixtures",
	"recording-1786458256937.mp4.cursor.json",
);

// The 6 `source: "auto"` zoom regions from Drew's real, saved `.openscreen`
// project for recording-1786461836877 — the exact empirical result recorded
// in kkm/products/lensmith/research/brief.md ("Validated, not assumed").
// This is the Acceptance Metric fixture-comparison, not a synthetic target.
const EXPECTED_AUTO_REGIONS = [
	{ startMs: 33145, endMs: 36178, focus: { cx: 0.2868183338909334, cy: 0.6815796693874754 } },
	{ startMs: 0, endMs: 3033, focus: { cx: 0.6061624649859938, cy: 0.7309254245631299 } },
	{ startMs: 12086, endMs: 15119, focus: { cx: 0.30087214372928645, cy: 0.39909880914064993 } },
	{ startMs: 43730, endMs: 46763, focus: { cx: 0.7299119647859139, cy: 0.8307900566084172 } },
	{ startMs: 57420, endMs: 60453, focus: { cx: 0.6894557823129253, cy: 0.2887402869097428 } },
	{ startMs: 6881, endMs: 9914, focus: { cx: 0.284108843537415, cy: 0.20602510460251044 } },
];

const RECORDING_DURATION_MS = 60453;
const DEFAULT_DURATION_MS = 3033;
const FOCUS_TOLERANCE = 0.001;
const TIMING_TOLERANCE_MS = 200;

describe("suggest-zooms — fixture comparison (Acceptance Metric)", () => {
	it(
		"reproduces all 6 real source:auto zoom regions from " +
			"recording-1786461836877, focus within 0.001 and timing within 200ms",
		() => {
			const { zoomRegions } = runSuggestZooms({
				cursorPath: FIXTURE_61836877,
				durationMs: RECORDING_DURATION_MS,
				defaultDurationMs: DEFAULT_DURATION_MS,
			});

			// Every known auto region must have exactly one matching produced
			// region, matched by proximity in start time — a stronger check
			// than a bare length assertion, and one that fails loudly (with
			// the unmatched expected region) rather than passing on a
			// coincidental count match.
			const remaining = [...zoomRegions];
			for (const expected of EXPECTED_AUTO_REGIONS) {
				let bestIndex = -1;
				let bestDelta = Number.POSITIVE_INFINITY;
				remaining.forEach((candidate, index) => {
					const delta = Math.abs(candidate.startMs - expected.startMs);
					if (delta < bestDelta) {
						bestDelta = delta;
						bestIndex = index;
					}
				});

				expect(
					bestIndex,
					`no produced region found near expected startMs=${expected.startMs}`,
				).toBeGreaterThanOrEqual(0);

				const match = remaining[bestIndex];
				expect(match).toBeDefined();
				if (!match) continue;

				expect(Math.abs(match.startMs - expected.startMs)).toBeLessThanOrEqual(TIMING_TOLERANCE_MS);
				expect(Math.abs(match.endMs - expected.endMs)).toBeLessThanOrEqual(TIMING_TOLERANCE_MS);
				expect(Math.abs(match.focus.cx - expected.focus.cx)).toBeLessThanOrEqual(FOCUS_TOLERANCE);
				expect(Math.abs(match.focus.cy - expected.focus.cy)).toBeLessThanOrEqual(FOCUS_TOLERANCE);
				expect(match.source).toBe("auto");
				expect(match.depth).toBe(3);
				expect(match.customScale).toBe(1.8);

				remaining.splice(bestIndex, 1);
			}
		},
	);

	it(
		"raw output also surfaces the 7th dwell candidate whose focus matches " +
			"the region Drew later hand-re-timed and promoted to source:manual " +
			"(documented in the .openscreen project — not a bug in the port)",
		() => {
			const { zoomRegions } = runSuggestZooms({
				cursorPath: FIXTURE_61836877,
				durationMs: RECORDING_DURATION_MS,
				defaultDurationMs: DEFAULT_DURATION_MS,
			});

			expect(zoomRegions).toHaveLength(7);

			const manualFocusMatch = zoomRegions.find(
				(region) =>
					Math.abs(region.focus.cx - 0.5473440440005787) <= FOCUS_TOLERANCE &&
					Math.abs(region.focus.cy - 0.07607050654322095) <= FOCUS_TOLERANCE,
			);
			expect(manualFocusMatch).toBeDefined();
		},
	);

	it("second real fixture (recording-1786458256937) runs without crashing and produces valid regions", () => {
		const raw = JSON.parse(readFileSync(FIXTURE_58256937, "utf-8")) as {
			samples: CursorTelemetryPoint[];
		};
		const lastSample = raw.samples.at(-1);
		expect(lastSample).toBeDefined();
		const totalMs = lastSample ? lastSample.timeMs : 0;

		const { zoomRegions } = runSuggestZooms({
			cursorPath: FIXTURE_58256937,
			durationMs: totalMs,
			defaultDurationMs: DEFAULT_DURATION_MS,
		});

		for (const region of zoomRegions) {
			expect(region.startMs).toBeGreaterThanOrEqual(0);
			expect(region.endMs).toBeLessThanOrEqual(totalMs);
			expect(region.endMs).toBeGreaterThan(region.startMs);
			expect(region.focus.cx).toBeGreaterThanOrEqual(0);
			expect(region.focus.cx).toBeLessThanOrEqual(1);
			expect(region.focus.cy).toBeGreaterThanOrEqual(0);
			expect(region.focus.cy).toBeLessThanOrEqual(1);
		}
	});
});

describe("suggest-zooms — edge cases", () => {
	it("near-empty telemetry produces an empty zoomRegions array, not a crash", () => {
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: [{ timeMs: 0, cx: 0.5, cy: 0.5 }],
			totalMs: 10000,
			existingRegions: [],
			defaultDurationMs: DEFAULT_DURATION_MS,
		});
		expect(suggestions).toEqual([]);
	});

	it("empty telemetry produces an empty zoomRegions array, not a crash", () => {
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: [],
			totalMs: 10000,
			existingRegions: [],
			defaultDurationMs: DEFAULT_DURATION_MS,
		});
		expect(suggestions).toEqual([]);
	});

	it("nonexistent cursor.json path throws a clear error", () => {
		expect(() =>
			runSuggestZooms({
				cursorPath: path.join(__dirname, "fixtures", "does-not-exist.cursor.json"),
				durationMs: 10000,
				defaultDurationMs: DEFAULT_DURATION_MS,
			}),
		).toThrow(/could not read cursor telemetry file/);
	});

	describe("malformed input", () => {
		let tmpDir: string;

		afterEach(() => {
			if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
		});

		it("invalid JSON syntax throws a clear error", () => {
			tmpDir = mkdtempSync(path.join(tmpdir(), "lensmith-test-"));
			const badFile = path.join(tmpDir, "broken.cursor.json");
			writeFileSync(badFile, "{ this is not valid json", "utf-8");

			expect(() =>
				runSuggestZooms({
					cursorPath: badFile,
					durationMs: 10000,
					defaultDurationMs: DEFAULT_DURATION_MS,
				}),
			).toThrow(/is not valid JSON/);
		});

		it('valid JSON missing a "samples" array throws a clear error', () => {
			tmpDir = mkdtempSync(path.join(tmpdir(), "lensmith-test-"));
			const badFile = path.join(tmpDir, "wrong-shape.cursor.json");
			writeFileSync(badFile, JSON.stringify({ version: 2, provider: "native" }), "utf-8");

			expect(() =>
				runSuggestZooms({
					cursorPath: badFile,
					durationMs: 10000,
					defaultDurationMs: DEFAULT_DURATION_MS,
				}),
			).toThrow(/does not look like a \.cursor\.json/);
		});
	});
});
