import { describe, expect, it } from "vitest";
import { CursorTelemetryRecorder } from "../src/lib/cursorTelemetry.js";

const BOUNDS = { x: 0, y: 0, width: 1000, height: 500 };

describe("CursorTelemetryRecorder", () => {
	it("normalizes cx/cy from the most recently known position at sample time", () => {
		const recorder = new CursorTelemetryRecorder(1_000, BOUNDS);
		recorder.recordPosition(500, 250); // dead center
		recorder.recordShapeSample({
			timestampMs: 1_500,
			assetId: null,
			leftButtonDown: false,
			leftButtonPressed: false,
			leftButtonReleased: false,
		});

		const data = recorder.toTelemetryData();
		expect(data.version).toBe(2);
		expect(data.provider).toBe("native");
		expect(data.samples).toHaveLength(1);
		expect(data.samples[0]).toMatchObject({ timeMs: 500, cx: 0.5, cy: 0.5, visible: true });
		expect(data.assets).toEqual([]);
	});

	it("clamps timeMs to 0 when a sample timestamp predates the recording start", () => {
		const recorder = new CursorTelemetryRecorder(1_000, BOUNDS);
		recorder.recordPosition(0, 0);
		recorder.recordShapeSample({
			timestampMs: 900,
			assetId: null,
			leftButtonDown: false,
			leftButtonPressed: false,
			leftButtonReleased: false,
		});
		expect(recorder.toTelemetryData().samples[0]?.timeMs).toBe(0);
	});

	it("marks a sample invisible only after 3 consecutive out-of-bounds positions", () => {
		const recorder = new CursorTelemetryRecorder(0, BOUNDS);
		const sample = (t: number) =>
			recorder.recordShapeSample({
				timestampMs: t,
				assetId: null,
				leftButtonDown: false,
				leftButtonPressed: false,
				leftButtonReleased: false,
			});

		recorder.recordPosition(-50, 250); // outside (negative x)
		sample(0);
		sample(33);
		expect(recorder.toTelemetryData().samples[0]?.visible).toBe(true);
		expect(recorder.toTelemetryData().samples[1]?.visible).toBe(true);

		sample(66); // 3rd consecutive outside sample
		expect(recorder.toTelemetryData().samples[2]?.visible).toBe(false);
	});

	it("has no false 'invisible' when no position has ever been reported yet", () => {
		const recorder = new CursorTelemetryRecorder(0, BOUNDS);
		recorder.recordShapeSample({
			timestampMs: 0,
			assetId: null,
			leftButtonDown: false,
			leftButtonPressed: false,
			leftButtonReleased: false,
		});
		expect(recorder.toTelemetryData().samples[0]?.visible).toBe(false);
	});

	it("classifies interactionType as click on button-down transition, mouseup on release", () => {
		const recorder = new CursorTelemetryRecorder(0, BOUNDS);
		recorder.recordPosition(500, 250);

		recorder.recordShapeSample({
			timestampMs: 0,
			assetId: null,
			leftButtonDown: false,
			leftButtonPressed: false,
			leftButtonReleased: false,
		});
		recorder.recordShapeSample({
			timestampMs: 33,
			assetId: null,
			leftButtonDown: true,
			leftButtonPressed: true,
			leftButtonReleased: false,
		});
		recorder.recordShapeSample({
			timestampMs: 66,
			assetId: null,
			leftButtonDown: false,
			leftButtonPressed: false,
			leftButtonReleased: true,
		});

		const samples = recorder.toTelemetryData().samples;
		expect(samples.map((s) => s.interactionType)).toEqual(["move", "click", "mouseup"]);
	});

	it("includes assetId only when the shape event carries one", () => {
		const recorder = new CursorTelemetryRecorder(0, BOUNDS);
		recorder.recordPosition(0, 0);
		recorder.recordShapeSample({
			timestampMs: 0,
			assetId: "abc123",
			leftButtonDown: false,
			leftButtonPressed: false,
			leftButtonReleased: false,
		});
		recorder.recordShapeSample({
			timestampMs: 33,
			assetId: null,
			leftButtonDown: false,
			leftButtonPressed: false,
			leftButtonReleased: false,
		});

		const samples = recorder.toTelemetryData().samples;
		expect(samples[0]).toHaveProperty("assetId", "abc123");
		expect(samples[1]).not.toHaveProperty("assetId");
	});

	// The vendored cursor helper only ships the (large, base64) `asset` bitmap payload the
	// first time a given cursor shape is seen — proof's CR-LENSMITH-A001-2 review confirmed
	// this is real, required input for CR-LENSMITH-A001-4 (process/render), which reads it
	// via an unmodified vendored frameRenderer.ts.
	it("captures the asset bitmap into a top-level assets[] the first time a shape is seen", () => {
		const recorder = new CursorTelemetryRecorder(0, BOUNDS);
		recorder.recordPosition(500, 250);
		const payload = {
			id: "abc123",
			imageDataUrl: "data:image/png;base64,AAAA",
			width: 56,
			height: 80,
			hotspotX: 10,
			hotspotY: 10,
			scaleFactor: 2,
		};

		recorder.recordShapeSample({
			timestampMs: 0,
			assetId: "abc123",
			asset: payload,
			leftButtonDown: false,
			leftButtonPressed: false,
			leftButtonReleased: false,
		});

		const data = recorder.toTelemetryData();
		expect(data.assets).toHaveLength(1);
		expect(data.assets[0]).toEqual({ ...payload, platform: "darwin" });
	});

	it("dedupes repeated asset payloads for the same id (helper only ships it once per shape)", () => {
		const recorder = new CursorTelemetryRecorder(0, BOUNDS);
		recorder.recordPosition(0, 0);
		const payload = {
			id: "abc123",
			imageDataUrl: "data:image/png;base64,AAAA",
			width: 56,
			height: 80,
			hotspotX: 10,
			hotspotY: 10,
			scaleFactor: 2,
		};

		recorder.recordShapeSample({
			timestampMs: 0,
			assetId: "abc123",
			asset: payload,
			leftButtonDown: false,
			leftButtonPressed: false,
			leftButtonReleased: false,
		});
		// Later samples referencing the same shape carry the assetId but no asset payload.
		recorder.recordShapeSample({
			timestampMs: 33,
			assetId: "abc123",
			asset: null,
			leftButtonDown: false,
			leftButtonPressed: false,
			leftButtonReleased: false,
		});

		expect(recorder.toTelemetryData().assets).toHaveLength(1);
	});

	it("falls back to the display scale factor when an asset payload omits its own", () => {
		const recorder = new CursorTelemetryRecorder(0, BOUNDS, 2);
		recorder.recordPosition(0, 0);
		recorder.recordShapeSample({
			timestampMs: 0,
			assetId: "xyz",
			asset: {
				id: "xyz",
				imageDataUrl: "data:image/png;base64,AAAA",
				width: 10,
				height: 10,
				hotspotX: 0,
				hotspotY: 0,
				// no scaleFactor
			},
			leftButtonDown: false,
			leftButtonPressed: false,
			leftButtonReleased: false,
		});

		expect(recorder.toTelemetryData().assets[0]?.scaleFactor).toBe(2);
	});

	it("BF-19: setBounds re-targets normalization to a new rectangle", () => {
		const recorder = new CursorTelemetryRecorder(0, BOUNDS);
		recorder.setBounds({ x: 100, y: 100, width: 200, height: 200 });
		recorder.recordPosition(200, 150);
		recorder.recordShapeSample({
			timestampMs: 5,
			assetId: null,
			leftButtonDown: false,
			leftButtonPressed: false,
			leftButtonReleased: false,
		});
		expect(recorder.toTelemetryData().samples[0]).toMatchObject({ cx: 0.5, cy: 0.25 });
	});

	describe("BF-28: setZero moves the zero to the first video frame", () => {
		const shape = (timestampMs: number, leftButtonPressed = false) => ({
			timestampMs,
			assetId: null,
			leftButtonDown: leftButtonPressed,
			leftButtonPressed,
			leftButtonReleased: false,
		});

		it("a sample 1000 ms after the first frame gets timeMs 1000, not 1180", () => {
			const recorder = new CursorTelemetryRecorder(10_000, BOUNDS);
			recorder.recordPosition(500, 250);
			const dropped = recorder.setZero(10_180);
			recorder.recordShapeSample(shape(11_180, true));
			expect(dropped).toBe(0);
			expect(recorder.toTelemetryData().samples[0]).toMatchObject({
				timeMs: 1_000,
				interactionType: "click",
			});
		});

		it("re-bases samples taken before setZero and drops those that land before the new zero", () => {
			const recorder = new CursorTelemetryRecorder(10_000, BOUNDS);
			recorder.recordPosition(500, 250);
			recorder.recordShapeSample(shape(10_050));
			recorder.recordShapeSample(shape(10_150));
			recorder.recordShapeSample(shape(10_200));
			recorder.recordShapeSample(shape(10_300));
			expect(recorder.toTelemetryData().samples.map((s) => s.timeMs)).toEqual([50, 150, 200, 300]);

			expect(recorder.setZero(10_180)).toBe(2);
			expect(recorder.sampleCount).toBe(2);
			expect(recorder.toTelemetryData().samples.map((s) => s.timeMs)).toEqual([20, 120]);
		});

		it("defaults the zero to the constructor's startTimeMs when setZero is never called", () => {
			const recorder = new CursorTelemetryRecorder(10_000, BOUNDS);
			recorder.recordShapeSample(shape(11_180));
			expect(recorder.toTelemetryData().samples[0]?.timeMs).toBe(1_180);
		});
	});
});
