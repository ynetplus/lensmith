/**
 * Merges the two native NDJSON streams into the `.cursor.json` sidecar
 * format the rest of the pipeline expects: `{version: 2, provider: "native",
 * samples: [{timeMs, cx, cy, visible, interactionType, assetId}], assets:
 * [{id, platform, imageDataUrl, width, height, hotspotX, hotspotY,
 * scaleFactor}]}` — confirmed against Drew's real fixture
 * (`<recording>.mp4.cursor.json`,
 * 3 populated assets) per /proof's CR-LENSMITH-A001-2 review. `assets` is
 * required input for CR-LENSMITH-A001-4 (process/render), which vendors
 * `frameRenderer.ts` unmodified and reads this exact field to draw the
 * cursor bitmap.
 *
 * The vendored OpenScreenMacOSCursorHelper reports cursor SHAPE (arrow /
 * pointer / text) and click state but never screen position — upstream
 * gets position from Electron's `screen.getCursorScreenPoint()`, called at
 * the moment each shape sample arrives
 * (electron/native-bridge/cursor/recording/macNativeCursorRecordingSession.ts).
 * Lensmith has no Electron, so `record.ts` runs a second helper
 * (`lensmith-cursor-position-helper`, Lensmith's own code — not vendored)
 * purely for position, and this class merges "most recent known position"
 * into each shape sample as it arrives — the closest a two-process,
 * no-Electron design can get to that synchronous read.
 *
 * The debounce/interaction-classification logic below mirrors the shape of
 * `MacNativeCursorRecordingSession.captureSample()`, read as reference
 * during this CR — this is a from-scratch TypeScript reimplementation for
 * Lensmith's own runtime, not a vendored copy. See NOTICE.md for what IS
 * vendored verbatim (it is not this file).
 */

export type CursorInteractionType = "move" | "click" | "mouseup";

export interface CursorSample {
	timeMs: number;
	cx: number;
	cy: number;
	visible: boolean;
	interactionType: CursorInteractionType;
	assetId?: string;
}

/** Mirrors upstream's `NativeCursorAsset` field-for-field (confirmed against Drew's real
 *  fixture, see file header) — the cursor bitmap a shape sample's `assetId` looks up. */
export interface CursorAsset {
	id: string;
	platform: "darwin";
	imageDataUrl: string;
	width: number;
	height: number;
	hotspotX: number;
	hotspotY: number;
	scaleFactor: number;
}

export interface CursorTelemetryData {
	version: 2;
	provider: "native";
	samples: CursorSample[];
	assets: CursorAsset[];
}

export interface DisplayBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Raw `asset` payload as emitted by the vendored cursor helper's `sample` event —
 *  present only the first time a given cursor shape is seen (see main.swift's
 *  `emittedAssetIds` dedup comment). `scaleFactor` is always populated by the helper in
 *  practice; the fallback exists only for defensive parity with upstream's own optional
 *  handling of it. */
export interface ShapeAssetPayload {
	id: string;
	imageDataUrl: string;
	width: number;
	height: number;
	hotspotX: number;
	hotspotY: number;
	scaleFactor?: number;
}

export interface ShapeSampleEvent {
	timestampMs: number;
	assetId: string | null;
	asset?: ShapeAssetPayload | null;
	leftButtonDown: boolean;
	leftButtonPressed: boolean;
	leftButtonReleased: boolean;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

// Consecutive out-of-bounds samples required before a sample is marked
// invisible — debounces brief off-screen flicks during fast cursor swipes
// near a display edge instead of producing a flickering overlay.
const OUTSIDE_HIDE_THRESHOLD = 3;

export class CursorTelemetryRecorder {
	private samples: CursorSample[] = [];
	private assets = new Map<string, CursorAsset>();
	private latestPosition: { x: number; y: number } | null = null;
	private previousLeftButtonDown = false;
	private consecutiveOutsideSamples = 0;

	constructor(
		private readonly startTimeMs: number,
		private readonly bounds: DisplayBounds,
		/** Fallback for `CursorAsset.scaleFactor` on the rare event the helper's own payload
		 *  omits it — mirrors upstream's `screen.getDisplayNearestPoint(cursor).scaleFactor`
		 *  fallback, computed here from the position helper's own pixel/point dimensions. */
		private readonly fallbackScaleFactor: number = 1,
	) {}

	recordPosition(x: number, y: number): void {
		this.latestPosition = { x, y };
	}

	private rememberAsset(asset: ShapeAssetPayload | null | undefined): void {
		if (!asset?.id || this.assets.has(asset.id)) {
			return;
		}
		this.assets.set(asset.id, {
			id: asset.id,
			platform: "darwin",
			imageDataUrl: asset.imageDataUrl,
			width: asset.width,
			height: asset.height,
			hotspotX: asset.hotspotX,
			hotspotY: asset.hotspotY,
			scaleFactor: asset.scaleFactor ?? this.fallbackScaleFactor,
		});
	}

	recordShapeSample(event: ShapeSampleEvent): void {
		this.rememberAsset(event.asset);
		const position = this.latestPosition;
		const width = Math.max(1, this.bounds.width);
		const height = Math.max(1, this.bounds.height);
		const normalizedX = position ? (position.x - this.bounds.x) / width : 0.5;
		const normalizedY = position ? (position.y - this.bounds.y) / height : 0.5;
		const isOutsideDisplay =
			normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1;

		if (isOutsideDisplay) {
			this.consecutiveOutsideSamples += 1;
		} else {
			this.consecutiveOutsideSamples = 0;
		}
		const visible = position !== null && this.consecutiveOutsideSamples < OUTSIDE_HIDE_THRESHOLD;

		const interactionType: CursorInteractionType =
			event.leftButtonPressed || (event.leftButtonDown && !this.previousLeftButtonDown)
				? "click"
				: event.leftButtonReleased || (!event.leftButtonDown && this.previousLeftButtonDown)
					? "mouseup"
					: "move";
		this.previousLeftButtonDown = event.leftButtonDown;

		this.samples.push({
			timeMs: Math.max(0, event.timestampMs - this.startTimeMs),
			cx: clamp(normalizedX, 0, 1),
			cy: clamp(normalizedY, 0, 1),
			visible,
			interactionType,
			...(event.assetId ? { assetId: event.assetId } : {}),
		});
	}

	get sampleCount(): number {
		return this.samples.length;
	}

	toTelemetryData(): CursorTelemetryData {
		return {
			version: 2,
			provider: "native",
			samples: this.samples,
			assets: [...this.assets.values()],
		};
	}
}
