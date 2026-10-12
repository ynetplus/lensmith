/**
 * Lensmith harness bootstrap (CR-LENSMITH-A001-4).
 *
 * Runs inside headless Chromium, driven by Playwright (see
 * `src/lib/harnessRunner.ts`). Hosts OpenScreen's vendored process/export
 * code (`vendor/openscreen/src/lib/exporter/*`, unmodified — see
 * `vendor/openscreen/NOTICE.md`) and exposes two entry points the Node
 * side calls via `page.evaluate()`:
 *
 *   window.lensmithProcess(input) -> MP4 export (VideoExporter)
 *   window.lensmithGif(input)     -> GIF export (GifExporter)
 *
 * This file (and the bridging logic below) is the one piece of NEW code —
 * everything it calls into under vendor/openscreen/ is untouched upstream
 * source. The bridging maps `EditorProjectData.editor` (the exact shape
 * OpenScreen's own "Save Project" writes, see projectPersistence.ts
 * upstream) onto `VideoExporterConfig` / the GifExporter config, following
 * the same construction OpenScreen's own `VideoEditor.tsx` export-dialog
 * handler uses (upstream `handleExport`, ~line 1860 and ~line 2130 of
 * `src/components/video-editor/VideoEditor.tsx`), so it isn't guessed.
 *
 * Fields intentionally defaulted rather than read from the project file:
 * cursorScale/cursorSmoothing/cursorMotionBlur/cursorClickBounce/
 * cursorClipToBounds. OpenScreen's `EditorProjectData.editor` does NOT
 * persist these (verified against upstream `projectPersistence.ts` —
 * they're app-level cursor-appearance settings, not per-project state).
 * We use upstream's own defaults (`DEFAULT_CURSOR_*` from
 * `video-editor/types.ts`), the same values a freshly-opened project would
 * use. cursorScale is 0 (cursor hidden) when no `--cursor` telemetry was
 * given, else the default size — the project schema has no explicit
 * "show cursor" flag either; showing it whenever telemetry is present is
 * the same effective behavior as the GUI (which offers no non-webcam
 * scenario where cursor telemetry exists but rendering is off by default).
 */

import {
	DEFAULT_CURSOR_CLICK_BOUNCE,
	DEFAULT_CURSOR_CLIP_TO_BOUNDS,
	DEFAULT_CURSOR_MOTION_BLUR,
	DEFAULT_CURSOR_SIZE,
	DEFAULT_CURSOR_SMOOTHING,
} from "@/components/video-editor/types";
import {
	calculateEffectiveSourceDimensions,
	calculateMp4ExportSettings,
	calculateOutputDimensions,
	GIF_SIZE_PRESETS,
	GifExporter,
	VideoExporter,
	VideoFileDecoder,
} from "@/lib/exporter";
import { getAspectRatioValue, getNativeAspectRatioValue } from "@/utils/aspectRatioUtils";
import { applyCursorShapes, CURSOR_SHAPES_DEFAULT } from "../lib/cursorShapes";

// ---------------------------------------------------------------------------
// Bridge types — shapes of the JSON that crosses the Node <-> page.evaluate()
// boundary. Loose (not the upstream branded types) on purpose: the data
// originates as JSON read off disk by the Node CLI, so structural typing is
// honest about what we actually have. Field NAMES match
// EditorProjectData.editor exactly (see CR scope).
// ---------------------------------------------------------------------------

interface BridgeEditor {
	wallpaper: string;
	shadowIntensity: number;
	showBlur: boolean;
	motionBlurAmount?: number;
	borderRadius?: number;
	padding?: number;
	cropRegion: { x: number; y: number; width: number; height: number };
	zoomRegions: unknown[];
	trimRegions?: unknown[];
	speedRegions?: unknown[];
	annotationRegions?: unknown[];
	aspectRatio: string;
	webcamLayoutPreset?: string;
	webcamMaskShape?: string;
	webcamMirrored?: boolean;
	webcamReactiveZoom?: boolean;
	webcamSizePreset?: number | string;
	webcamPosition?: { cx: number; cy: number } | null;
	exportQuality: "medium" | "good" | "source";
	gifFrameRate: 15 | 20 | 25 | 30;
	gifLoop: boolean;
	gifSizePreset: "medium" | "large" | "original";
	cursorTheme: string;
}

interface CursorSample {
	timeMs: number;
	cx: number;
	cy: number;
	assetId?: string | null;
	visible?: boolean;
	cursorType?: string | null;
	interactionType?: "move" | "click" | "mouseup";
}

interface CursorRecordingDataLike {
	version: number;
	provider: string;
	samples: CursorSample[];
	assets: unknown[];
}

interface BridgeInput {
	editor: BridgeEditor;
	videoUrl: string;
	webcamVideoUrl?: string;
	cursorRecordingData: CursorRecordingDataLike | null;
	cursorShapes?: "arrow" | "native";
	outputUploadUrl: string;
}

interface BridgeResult {
	success: boolean;
	error?: string;
	warnings?: string[];
	width?: number;
	height?: number;
	bitrate?: number;
}

function withCursorShapes(input: BridgeInput): BridgeInput {
	const shapes = input.cursorShapes ?? CURSOR_SHAPES_DEFAULT;
	return { ...input, cursorRecordingData: applyCursorShapes(input.cursorRecordingData, shapes) };
}

function deriveCursorTelemetry(data: CursorRecordingDataLike | null) {
	if (!data) return [];
	return data.samples.map((s) => ({ timeMs: s.timeMs, cx: s.cx, cy: s.cy }));
}

function deriveClickTimestamps(data: CursorRecordingDataLike | null): number[] {
	if (!data) return [];
	return data.samples.filter((s) => s.interactionType === "click").map((s) => s.timeMs);
}

/**
 * A real render is thousands of frames — logging every onProgress call
 * would flood stdout. Logs at most once every ~2s of wall-clock time plus
 * always on phase transitions, forwarded to Node via harnessRunner's
 * console listener.
 */
function throttledProgressLogger() {
	let lastLoggedAt = 0;
	let lastPhase: string | undefined;
	return (p: { phase?: string; currentFrame: number; totalFrames: number }) => {
		const now = Date.now();
		const phaseChanged = p.phase !== lastPhase;
		if (phaseChanged || now - lastLoggedAt >= 2000 || p.currentFrame === p.totalFrames) {
			console.log(`[lensmith] ${p.phase ?? "rendering"}: frame ${p.currentFrame}/${p.totalFrames}`);
			lastLoggedAt = now;
			lastPhase = p.phase;
		}
	};
}

async function loadSourceDimensions(videoUrl: string): Promise<{ width: number; height: number }> {
	const decoder = new VideoFileDecoder();
	try {
		const info = await decoder.loadVideo(videoUrl);
		return { width: info.width, height: info.height };
	} finally {
		decoder.destroy();
	}
}

async function uploadBlob(blob: Blob, url: string): Promise<void> {
	const res = await fetch(url, { method: "POST", body: blob });
	if (!res.ok) {
		throw new Error(`harness upload failed: ${res.status} ${res.statusText}`);
	}
}

function resolveAspectRatioValue(
	aspectRatio: string,
	sourceWidth: number,
	sourceHeight: number,
	cropRegion: BridgeEditor["cropRegion"],
): number {
	if (aspectRatio === "native") {
		return getNativeAspectRatioValue(sourceWidth, sourceHeight, cropRegion);
	}
	// getAspectRatioValue is typed to the upstream AspectRatio union; the
	// project file is trusted to carry one of those literal strings (it's
	// OpenScreen's own persisted format).
	// biome-ignore lint/suspicious/noExplicitAny: bridging untyped disk JSON into upstream's branded union
	return getAspectRatioValue(aspectRatio as any);
}

async function runProcess(rawInput: BridgeInput): Promise<BridgeResult> {
	const input = withCursorShapes(rawInput);
	const { editor } = input;
	const { width: sourceWidth, height: sourceHeight } = await loadSourceDimensions(input.videoUrl);
	const effective = calculateEffectiveSourceDimensions(
		sourceWidth,
		sourceHeight,
		editor.cropRegion,
	);
	const aspectRatioValue = resolveAspectRatioValue(
		editor.aspectRatio,
		sourceWidth,
		sourceHeight,
		editor.cropRegion,
	);
	const { width, height, bitrate } = calculateMp4ExportSettings({
		quality: editor.exportQuality,
		sourceWidth: effective.width,
		sourceHeight: effective.height,
		aspectRatioValue,
	});
	console.log(`[bootstrap] export target: ${width}x${height} @ ${bitrate}bps`);

	const hasCursor = Boolean(input.cursorRecordingData);

	// VideoExporterConfig isn't exported from the vendored module; field
	// names verified 1:1 against upstream (see the file header comment).
	const exporter = new VideoExporter({
		videoUrl: input.videoUrl,
		webcamVideoUrl: input.webcamVideoUrl,
		width,
		height,
		frameRate: 60,
		bitrate,
		codec: "avc1.640033",
		wallpaper: editor.wallpaper,
		zoomRegions: editor.zoomRegions,
		trimRegions: editor.trimRegions,
		speedRegions: editor.speedRegions,
		showShadow: editor.shadowIntensity > 0,
		shadowIntensity: editor.shadowIntensity,
		showBlur: editor.showBlur,
		motionBlurAmount: editor.motionBlurAmount,
		borderRadius: editor.borderRadius,
		padding: editor.padding,
		cropRegion: editor.cropRegion,
		cursorRecordingData: input.cursorRecordingData,
		cursorScale: hasCursor ? DEFAULT_CURSOR_SIZE : 0,
		cursorSmoothing: DEFAULT_CURSOR_SMOOTHING,
		cursorMotionBlur: DEFAULT_CURSOR_MOTION_BLUR,
		cursorClickBounce: DEFAULT_CURSOR_CLICK_BOUNCE,
		cursorClipToBounds: DEFAULT_CURSOR_CLIP_TO_BOUNDS,
		cursorTheme: editor.cursorTheme,
		annotationRegions: editor.annotationRegions,
		webcamLayoutPreset: editor.webcamLayoutPreset,
		webcamMaskShape: editor.webcamMaskShape,
		webcamMirrored: editor.webcamMirrored,
		webcamReactiveZoom: editor.webcamReactiveZoom,
		webcamSizePreset: editor.webcamSizePreset,
		webcamPosition: editor.webcamPosition,
		cursorTelemetry: deriveCursorTelemetry(input.cursorRecordingData),
		cursorClickTimestamps: deriveClickTimestamps(input.cursorRecordingData),
		onProgress: throttledProgressLogger(),
		// biome-ignore lint/suspicious/noExplicitAny: VideoExporterConfig isn't exported from the vendored module (see comment above)
	} as any);

	const result = await exporter.export();
	if (!result.success || !result.blob) {
		return { success: false, error: result.error || "export failed", warnings: result.warnings };
	}

	await uploadBlob(result.blob, input.outputUploadUrl);
	return { success: true, warnings: result.warnings, width, height, bitrate };
}

async function runGif(rawInput: BridgeInput): Promise<BridgeResult> {
	const input = withCursorShapes(rawInput);
	const { editor } = input;
	const { width: sourceWidth, height: sourceHeight } = await loadSourceDimensions(input.videoUrl);
	const effective = calculateEffectiveSourceDimensions(
		sourceWidth,
		sourceHeight,
		editor.cropRegion,
	);
	const aspectRatioValue = resolveAspectRatioValue(
		editor.aspectRatio,
		sourceWidth,
		sourceHeight,
		editor.cropRegion,
	);
	const gifDimensions = calculateOutputDimensions(
		effective.width,
		effective.height,
		editor.gifSizePreset,
		GIF_SIZE_PRESETS,
		aspectRatioValue,
	);

	const hasCursor = Boolean(input.cursorRecordingData);

	// GifExporterConfig isn't exported from the vendored module; field names
	// verified 1:1 against upstream (see the file header comment).
	const exporter = new GifExporter({
		videoUrl: input.videoUrl,
		webcamVideoUrl: input.webcamVideoUrl,
		width: gifDimensions.width,
		height: gifDimensions.height,
		frameRate: editor.gifFrameRate,
		loop: editor.gifLoop,
		sizePreset: editor.gifSizePreset,
		wallpaper: editor.wallpaper,
		zoomRegions: editor.zoomRegions,
		trimRegions: editor.trimRegions,
		speedRegions: editor.speedRegions,
		showShadow: editor.shadowIntensity > 0,
		shadowIntensity: editor.shadowIntensity,
		showBlur: editor.showBlur,
		motionBlurAmount: editor.motionBlurAmount,
		borderRadius: editor.borderRadius,
		padding: editor.padding,
		videoPadding: editor.padding,
		cropRegion: editor.cropRegion,
		cursorRecordingData: input.cursorRecordingData,
		cursorScale: hasCursor ? DEFAULT_CURSOR_SIZE : 0,
		cursorSmoothing: DEFAULT_CURSOR_SMOOTHING,
		cursorMotionBlur: DEFAULT_CURSOR_MOTION_BLUR,
		cursorClickBounce: DEFAULT_CURSOR_CLICK_BOUNCE,
		cursorClipToBounds: DEFAULT_CURSOR_CLIP_TO_BOUNDS,
		cursorTheme: editor.cursorTheme,
		annotationRegions: editor.annotationRegions,
		webcamLayoutPreset: editor.webcamLayoutPreset,
		webcamMaskShape: editor.webcamMaskShape,
		webcamMirrored: editor.webcamMirrored,
		webcamReactiveZoom: editor.webcamReactiveZoom,
		webcamSizePreset: editor.webcamSizePreset,
		webcamPosition: editor.webcamPosition,
		cursorTelemetry: deriveCursorTelemetry(input.cursorRecordingData),
		cursorClickTimestamps: deriveClickTimestamps(input.cursorRecordingData),
		onProgress: throttledProgressLogger(),
		// biome-ignore lint/suspicious/noExplicitAny: GifExporterConfig isn't exported from the vendored module (see comment above)
	} as any);

	const result = await exporter.export();
	if (!result.success || !result.blob) {
		return {
			success: false,
			error: result.error || "gif export failed",
			warnings: result.warnings,
		};
	}

	await uploadBlob(result.blob, input.outputUploadUrl);
	return {
		success: true,
		warnings: result.warnings,
		width: gifDimensions.width,
		height: gifDimensions.height,
	};
}

declare global {
	interface Window {
		lensmithProcess: (input: BridgeInput) => Promise<BridgeResult>;
		lensmithGif: (input: BridgeInput) => Promise<BridgeResult>;
		__lensmithHarnessReady?: boolean;
	}
}

window.lensmithProcess = async (input: BridgeInput): Promise<BridgeResult> => {
	try {
		return await runProcess(input);
	} catch (e) {
		return {
			success: false,
			error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e),
		};
	}
};

window.lensmithGif = async (input: BridgeInput): Promise<BridgeResult> => {
	try {
		return await runGif(input);
	} catch (e) {
		return {
			success: false,
			error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e),
		};
	}
};

window.__lensmithHarnessReady = true;
