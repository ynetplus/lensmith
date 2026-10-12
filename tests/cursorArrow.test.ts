import { describe, expect, it } from "vitest";
import { applyCursorShapes, parseCursorShapes } from "../src/lib/cursorShapes.js";

// CR-LENSMITH-A007-11: films always draw the arrow.
const data = {
	version: 2,
	provider: "native",
	assets: [{ id: "a" }],
	samples: [
		{ timeMs: 0, cx: 0.1, cy: 0.2, assetId: "a", cursorType: "pointer", interactionType: "move" },
		{ timeMs: 10, cx: 0.3, cy: 0.4, assetId: "a", cursorType: "text", interactionType: "click" },
		{ timeMs: 20, cx: 0.5, cy: 0.6, assetId: "a", cursorType: null, interactionType: "mouseup" },
		{ timeMs: 30, cx: 0.7, cy: 0.8, cursorType: "open-hand", visible: false },
		{ timeMs: 40, cx: 0.9, cy: 0.1 },
	],
};

describe("applyCursorShapes", () => {
	it("arrow: every sample becomes the arrow, nothing else changes", () => {
		const out = applyCursorShapes(data, "arrow");
		expect(out.samples.every((s) => (s as { cursorType: string }).cursorType === "arrow")).toBe(
			true,
		);
		const strip = (s: object) => {
			const { cursorType: _c, ...rest } = s as Record<string, unknown>;
			return rest;
		};
		expect(out.samples.map(strip)).toEqual(data.samples.map(strip));
		expect(out.assets).toEqual(data.assets);
	});
	it("arrow: does not mutate its input", () => {
		applyCursorShapes(data, "arrow");
		expect((data.samples[0] as { cursorType: string }).cursorType).toBe("pointer");
	});
	it("native: returns the telemetry unchanged", () => {
		expect(applyCursorShapes(data, "native")).toBe(data);
	});
	it("null telemetry stays null", () => {
		expect(applyCursorShapes(null, "arrow")).toBeNull();
	});
});

describe("parseCursorShapes", () => {
	it("accepts arrow and native, rejects anything else", () => {
		expect(parseCursorShapes("arrow")).toBe("arrow");
		expect(parseCursorShapes("native")).toBe("native");
		expect(() => parseCursorShapes("hand")).toThrow(/--cursor-shapes/);
	});
});
