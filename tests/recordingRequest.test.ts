import { describe, expect, it } from "vitest";
import {
	buildRecordingRequest,
	captureCeiling,
	InvalidSourceError,
	parseSourceFlag,
} from "../src/lib/recordingRequest.js";

describe("parseSourceFlag", () => {
	it('"screen" resolves to a display source using the given main display id', () => {
		const source = parseSourceFlag("screen", 1);
		expect(source).toEqual({ type: "display", sourceId: "display:1", displayId: 1 });
	});

	it('"window:<id>" resolves to a window source', () => {
		const source = parseSourceFlag("window:42", 1);
		expect(source).toEqual({ type: "window", sourceId: "window:42", windowId: 42 });
	});

	it("rejects a non-numeric window id (edge case QA: clear error, not a crash)", () => {
		expect(() => parseSourceFlag("window:abc", 1)).toThrow(InvalidSourceError);
	});

	it("rejects an unrecognized source string", () => {
		expect(() => parseSourceFlag("bogus", 1)).toThrow(InvalidSourceError);
	});

	it("rejects an empty window id", () => {
		expect(() => parseSourceFlag("window:", 1)).toThrow(InvalidSourceError);
	});
});

describe("buildRecordingRequest", () => {
	it("produces every field the vendored Decodable RecordingRequest struct requires", () => {
		const request = buildRecordingRequest({
			source: { type: "display", sourceId: "display:1", displayId: 1 },
			fps: 60,
			mic: true,
			systemAudio: true,
			screenPath: "/tmp/out.mp4",
			fallbackWidth: 1920,
			fallbackHeight: 1080,
		});

		expect(request.source).toEqual({ type: "display", sourceId: "display:1", displayId: 1 });
		expect(request.video).toEqual({
			fps: 60,
			width: 1920,
			height: 1080,
			hideSystemCursor: true,
		});
		expect(request.audio).toEqual({
			system: { enabled: true },
			microphone: { enabled: true, gain: 1.0 },
		});
		expect(request.webcam.enabled).toBe(false);
		expect(request.cursor).toEqual({ mode: "editable-overlay" });
		expect(request.outputs).toEqual({ screenPath: "/tmp/out.mp4" });
	});

	it("omits displayId/windowId when not applicable to the parsed source", () => {
		const windowRequest = buildRecordingRequest({
			source: { type: "window", sourceId: "window:7", windowId: 7 },
			fps: 30,
			mic: false,
			systemAudio: false,
			screenPath: "/tmp/out.mp4",
			fallbackWidth: 800,
			fallbackHeight: 600,
		});
		expect(windowRequest.source).toEqual({ type: "window", sourceId: "window:7", windowId: 7 });
		expect(windowRequest.source).not.toHaveProperty("displayId");
	});
});

// BF-18: the ceiling is the display's PIXEL size (helper `ready` pixelWidth/pixelHeight),
// never its point size. `clamp` mirrors clampCaptureDimension() in the vendored Swift helper.
describe("capture ceiling (BF-18)", () => {
	const clamp = (value: number, fallback: number) => {
		const requested = Math.max(2, fallback);
		const candidate = value > 0 ? value : requested;
		const clamped = Math.min(candidate, requested);
		return Math.max(2, clamped - (clamped % 2));
	};
	// 1920x1080@2x: bounds (points) 1920x1080, display mode pixels 3840x2160.
	const retinaReady = { pixelWidth: 3840, pixelHeight: 2160, pointWidth: 1920, pointHeight: 1080 };

	it("takes the ceiling from the pixel fields, not the point fields", () => {
		expect(captureCeiling(retinaReady)).toEqual({ fallbackWidth: 3840, fallbackHeight: 2160 });
	});

	it("flows into the recording request's video size", () => {
		const request = buildRecordingRequest({
			source: { type: "window", sourceId: "window:7", windowId: 7 },
			fps: 60,
			mic: false,
			systemAudio: false,
			screenPath: "/tmp/out.mp4",
			...captureCeiling(retinaReady),
		});
		expect(request.video.width).toBe(3840);
		expect(request.video.height).toBe(2160);
	});

	it("a 1600x900 window at scale 2 on a 1920x1080@2x display is not clamped", () => {
		const { fallbackWidth, fallbackHeight } = captureCeiling(retinaReady);
		expect(clamp(1600 * 2, fallbackWidth)).toBe(3200);
		expect(clamp(900 * 2, fallbackHeight)).toBe(1800);
	});

	it("1x display: ceiling and capture sizes are unchanged", () => {
		const { fallbackWidth, fallbackHeight } = captureCeiling({
			pixelWidth: 1920,
			pixelHeight: 1080,
		});
		expect(clamp(1600, fallbackWidth)).toBe(1600);
		expect(clamp(900, fallbackHeight)).toBe(900);
	});

	it("regression: the old point-sized ceiling clamped the same window to 1920x1080", () => {
		expect(clamp(3200, 1920)).toBe(1920);
		expect(clamp(1800, 1080)).toBe(1080);
	});
});
