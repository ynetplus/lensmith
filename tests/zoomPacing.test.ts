import { describe, expect, it } from "vitest";
import {
	CONNECTED_ZOOM_PAN_DURATION_MS,
	SETTLE_CURVE,
	TRANSITION_WINDOW_MS,
	ZOOM_IN_TRANSITION_WINDOW_MS,
} from "../vendor/openscreen/src/components/video-editor/videoPlayback/constants.js";
import {
	computeRegionStrength,
	easeSettle,
	findDominantRegion,
} from "../vendor/openscreen/src/components/video-editor/videoPlayback/zoomRegionUtils.js";

// CR-LENSMITH-A007-9: the Settle pacing (Pacing card, treatment C) on the pure
// timing functions of the vendored renderer. Every number below is from the
// Settle spec table: zoom in 900 ms, zoom out 700 ms, pan 700 ms, all on
// cubic-bezier(0.4, 0, 0.2, 1), zoom-in window starting AT startMs.

// Independent reference: solve x(t) = p by bisection, return y(t). Not the
// renderer's Newton solver, so a bug there cannot hide behind itself.
function referenceBezier(p: number): number {
	const [x1, y1, x2, y2] = [0.4, 0, 0.2, 1];
	const at = (a: number, b: number, t: number) =>
		3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 60; i += 1) {
		const mid = (lo + hi) / 2;
		if (at(x1, x2, mid) < p) lo = mid;
		else hi = mid;
	}
	return at(y1, y2, (lo + hi) / 2);
}

const region = (over: Record<string, unknown> = {}) =>
	({
		id: "r1",
		startMs: 10_000,
		endMs: 13_000,
		depth: 3,
		customScale: 1.8,
		focus: { cx: 0.3, cy: 0.4 },
		...over,
	}) as never;

describe("Settle constants (one block)", () => {
	it("holds the spec numbers", () => {
		expect(ZOOM_IN_TRANSITION_WINDOW_MS).toBe(900);
		expect(TRANSITION_WINDOW_MS).toBe(700);
		expect(CONNECTED_ZOOM_PAN_DURATION_MS).toBe(700);
		expect(SETTLE_CURVE).toEqual({ x1: 0.4, y1: 0, x2: 0.2, y2: 1 });
	});
});

describe("zoom in: window [startMs, startMs + 900]", () => {
	const r = region();
	it("is 0 at startMs and 1 at startMs + 900, nothing before", () => {
		expect(computeRegionStrength(r, 9_999)).toBe(0);
		expect(computeRegionStrength(r, 10_000)).toBe(0);
		expect(computeRegionStrength(r, 10_900)).toBe(1);
		expect(computeRegionStrength(r, 11_000)).toBe(1);
	});
	it("does not begin before startMs (no 1.3 s lead-in)", () => {
		expect(computeRegionStrength(r, 9_000)).toBe(0);
		expect(computeRegionStrength(r, 9_700)).toBe(0);
	});
	it.each([0.25, 0.5, 0.75])("matches cubic-bezier(0.4,0,0.2,1) at %d of the window", (p) => {
		const got = computeRegionStrength(r, 10_000 + 900 * p);
		expect(got).toBeCloseTo(referenceBezier(p), 4);
		expect(easeSettle(p)).toBeCloseTo(referenceBezier(p), 4);
	});
	it("has no lunge: under 40 percent of the change in the first 25 percent", () => {
		expect(computeRegionStrength(r, 10_000 + 900 * 0.25)).toBeLessThan(0.4);
	});
});

describe("zoom out: window [endMs, endMs + 700]", () => {
	const r = region();
	it("holds 1 until endMs, is 0 at endMs + 700, nothing after", () => {
		expect(computeRegionStrength(r, 13_000)).toBe(1);
		expect(computeRegionStrength(r, 13_700)).toBe(0);
		expect(computeRegionStrength(r, 13_701)).toBe(0);
	});
	it.each([0.25, 0.5, 0.75])("matches 1 - cubic-bezier(0.4,0,0.2,1) at %d of the window", (p) => {
		const got = computeRegionStrength(r, 13_000 + 700 * p);
		expect(got).toBeCloseTo(1 - referenceBezier(p), 4);
	});
});

describe("connect flag: pan only when marked", () => {
	const a = region({ id: "a", startMs: 1_000, endMs: 4_000, focus: { cx: 0.25, cy: 0.5 } });
	const bPlain = region({ id: "b", startMs: 4_500, endMs: 8_000, focus: { cx: 0.75, cy: 0.5 } });
	const aConnected = region({ ...a, connect: true });
	const opts = { connectZooms: true };

	it("pans 700 ms on the Settle curve when the region has connect: true", () => {
		const regions = [aConnected, bPlain];
		expect(findDominantRegion(regions, 4_000, opts).transition).not.toBeNull();
		const mid = findDominantRegion(regions, 4_000 + 700 * 0.5, opts);
		expect(mid.transition?.progress).toBeCloseTo(referenceBezier(0.5), 4);
		const q = findDominantRegion(regions, 4_000 + 700 * 0.25, opts);
		expect(q.transition?.progress).toBeCloseTo(referenceBezier(0.25), 4);
		// pan finished at +700: no longer a transition
		expect(findDominantRegion(regions, 4_000 + 701, opts).transition).toBeNull();
	});

	it("never pans when connect is false or absent, even 20 ms apart", () => {
		for (const first of [a, region({ ...a, connect: false })]) {
			const close = region({ ...bPlain, startMs: 4_020 });
			const regions = [first, close];
			for (const t of [4_000, 4_100, 4_350, 4_699]) {
				expect(findDominantRegion(regions, t, opts).transition).toBeNull();
			}
			// 800 ms of breath at 1x between regions: the first zooms out instead of chaining
			const spaced = [first, region({ ...bPlain, startMs: 4_800 })];
			const out = findDominantRegion(spaced, 4_000 + 350, opts);
			expect(out.transition).toBeNull();
			expect(out.strength).toBeCloseTo(1 - referenceBezier(0.5), 4);
		}
	});

	it("an absent flag behaves like false with connectZooms off as well", () => {
		const regions = [a, bPlain];
		expect(findDominantRegion(regions, 4_300, {}).transition).toBeNull();
	});
});
