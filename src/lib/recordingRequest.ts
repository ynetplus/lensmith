/**
 * Builds the `RecordingRequest` JSON the vendored ScreenCaptureKit helper
 * expects, and parses the CLI's `--source` flag into it. Field names below
 * are copied field-for-field from the `Decodable` structs in
 * `src/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/main.swift`
 * (read directly, not guessed — forge pre-read requirement, CR-LENSMITH-A001-2).
 */

export class InvalidSourceError extends Error {}

export interface ParsedSource {
	type: "display" | "window";
	sourceId: string;
	displayId?: number;
	windowId?: number;
}

const WINDOW_SOURCE_PATTERN = /^window:(\d+)$/;

/**
 * Validates `--source`'s shape only (`"screen"` or `"window:<numeric-id>"`) — pure argument
 * parsing, no filesystem/native-helper dependency. Callable at CLI-parse time, before any
 * native helper is resolved or spawned (CR-LENSMITH-A001-2 bugfix, main-branch test fix
 * riding along with CR-LENSMITH-A001-4: `parseSourceFlag` alone can't run this early because
 * it needs `mainDisplayId`, which only the position helper's `ready` event provides).
 */
export function assertValidSourceSyntax(raw: string): void {
	if (raw === "screen") return;
	if (WINDOW_SOURCE_PATTERN.test(raw)) return;
	throw new InvalidSourceError(
		`Invalid --source "${raw}". Expected "screen" or "window:<numeric-window-id>".`,
	);
}

/** `--source screen` targets the main display; `--source window:<id>` a specific window. */
export function parseSourceFlag(raw: string, mainDisplayId: number): ParsedSource {
	assertValidSourceSyntax(raw);

	if (raw === "screen") {
		return { type: "display", sourceId: `display:${mainDisplayId}`, displayId: mainDisplayId };
	}

	const match = WINDOW_SOURCE_PATTERN.exec(raw);
	const windowId = Number((match as RegExpExecArray)[1]);
	return { type: "window", sourceId: `window:${windowId}`, windowId };
}

/**
 * BF-18: the capture size ceiling is the main display's real PIXEL size. The position
 * helper's `ready` event reports it as `pixelWidth`/`pixelHeight` (display-mode pixels,
 * not CGDisplayPixelsWide/High, which are points on a HiDPI display).
 */
export function captureCeiling(ready: { pixelWidth: number; pixelHeight: number }): {
	fallbackWidth: number;
	fallbackHeight: number;
} {
	return { fallbackWidth: ready.pixelWidth, fallbackHeight: ready.pixelHeight };
}

export interface BuildRecordingRequestOptions {
	source: ParsedSource;
	fps: number;
	mic: boolean;
	systemAudio: boolean;
	screenPath: string;
	/** Real target pixel dimensions (from the position helper's `ready` event) — used as the
	 *  `video.width`/`video.height` fallback/clamp ceiling the Swift helper applies via its own
	 *  `clampCaptureDimension()`. Must be >= the real display/window size or capture gets
	 *  downscaled to this value. */
	fallbackWidth: number;
	fallbackHeight: number;
}

/** Mirrors `RecordingRequest: Decodable` in the vendored Swift helper, field-for-field. */
export interface RecordingRequest {
	schemaVersion: number;
	source: {
		type: "display" | "window";
		sourceId: string;
		displayId?: number;
		windowId?: number;
	};
	video: {
		fps: number;
		width: number;
		height: number;
		hideSystemCursor: boolean;
	};
	audio: {
		system: { enabled: boolean };
		microphone: { enabled: boolean; gain: number };
	};
	webcam: {
		enabled: boolean;
		width: number;
		height: number;
		fps: number;
	};
	cursor: { mode: string };
	outputs: { screenPath: string };
}

export function buildRecordingRequest(options: BuildRecordingRequestOptions): RecordingRequest {
	const { source } = options;
	return {
		schemaVersion: 1,
		source: {
			type: source.type,
			sourceId: source.sourceId,
			...(source.displayId !== undefined ? { displayId: source.displayId } : {}),
			...(source.windowId !== undefined ? { windowId: source.windowId } : {}),
		},
		video: {
			fps: options.fps,
			width: options.fallbackWidth,
			height: options.fallbackHeight,
			// Lensmith always records in "editable-overlay" mode (see `.session.json`'s fixed
			// `cursorCaptureMode`) — the system cursor is hidden so the cursor telemetry in
			// `.cursor.json` can drive a redrawn, editable cursor overlay in a later processing
			// step (CR-LENSMITH-A004, out of scope here).
			hideSystemCursor: true,
		},
		audio: {
			system: { enabled: options.systemAudio },
			microphone: { enabled: options.mic, gain: 1.0 },
		},
		// Non-optional in the Decodable struct even though Lensmith v1 has no webcam feature —
		// these values are inert (never read by the helper) when `enabled: false`.
		webcam: {
			enabled: false,
			width: 1280,
			height: 720,
			fps: 30,
		},
		cursor: { mode: "editable-overlay" },
		outputs: {
			screenPath: options.screenPath,
		},
	};
}
