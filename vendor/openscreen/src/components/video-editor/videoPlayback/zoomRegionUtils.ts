/**
 * Vendored verbatim from OpenScreen (MIT, (c) 2025 Siddharth Vaddem).
 * Source: https://github.com/siddharthvaddem/openscreen
 * Commit: f57e36e25448b5af6c7b1b271066fe5beb9b8a49 (2026-06-16)
 * Path (upstream): src/components/video-editor/videoPlayback/zoomRegionUtils.ts
 * See NOTICE.md. Unmodified except where noted inline with "LENSMITH:".
 */
import type { CursorTelemetryPoint, Rotation3D, ZoomFocus, ZoomRegion } from "../types";
import { DEFAULT_ROTATION_3D, getRotation3D, getZoomScale, lerpRotation3D } from "../types";
import {
	CONNECTED_ZOOM_PAN_DURATION_MS,
	SETTLE_CURVE,
	TRANSITION_WINDOW_MS,
	ZOOM_IN_TRANSITION_WINDOW_MS,
} from "./constants";
import { interpolateCursorAt } from "./cursorFollowUtils";
import { clampFocusToScale } from "./focusUtils";
import { clamp01, cubicBezier } from "./mathUtils";

// LENSMITH: CR-LENSMITH-A007-9 removed CHAINED_ZOOM_PAN_GAP_MS (1500, time-gap chaining),
// CONNECTED_ZOOM_PAN_DURATION_MS (now in constants.ts) and ZOOM_IN_OVERLAP_MS (500, the zoom-in
// used to end 500 ms after startMs). Chaining is now decided by the region's `connect` flag.

type DominantRegionOptions = {
	connectZooms?: boolean;
	cursorTelemetry?: CursorTelemetryPoint[];
	viewportRatio?: ViewportRatio;
};

type ConnectedRegionPair = {
	currentRegion: ZoomRegion;
	nextRegion: ZoomRegion;
	transitionStart: number;
	transitionEnd: number;
};

type ConnectedPanTransition = {
	progress: number;
	startFocus: ZoomFocus;
	endFocus: ZoomFocus;
	startScale: number;
	endScale: number;
};

function lerp(start: number, end: number, amount: number) {
	return start + (end - start) * amount;
}

// LENSMITH: the Settle curve, shared by zoom in, zoom out and the connected pan
// (upstream: easeOutScreenStudio for in/out, cubicBezier(0.1, 0, 0.2, 1) for the pan).
export function easeSettle(value: number) {
	return cubicBezier(SETTLE_CURVE.x1, SETTLE_CURVE.y1, SETTLE_CURVE.x2, SETTLE_CURVE.y2, value);
}

function easeConnectedPan(value: number) {
	return easeSettle(value);
}

// LENSMITH: `connect` is not in the vendored ZoomRegion type; read it here, absent means false
// (older zoom fragments zoom out between regions instead of chaining).
function isConnected(region: ZoomRegion) {
	return (region as ZoomRegion & { connect?: boolean }).connect === true;
}

export function computeRegionStrength(region: ZoomRegion, timeMs: number) {
	// LENSMITH: the zoom-in window now begins AT startMs (upstream: it ended 500 ms after it).
	const leadInStart = region.startMs;
	const zoomInEnd = leadInStart + ZOOM_IN_TRANSITION_WINDOW_MS;
	const leadOutEnd = region.endMs + TRANSITION_WINDOW_MS;

	if (timeMs < leadInStart || timeMs > leadOutEnd) {
		return 0;
	}

	if (timeMs < zoomInEnd) {
		const progress = (timeMs - leadInStart) / ZOOM_IN_TRANSITION_WINDOW_MS;
		return easeSettle(progress); // LENSMITH: was easeOutScreenStudio
	}

	if (timeMs <= region.endMs) {
		return 1;
	}

	const progress = clamp01((timeMs - region.endMs) / TRANSITION_WINDOW_MS);
	return 1 - easeSettle(progress); // LENSMITH: was 1 - easeOutScreenStudio
}

function getLinearFocus(start: ZoomFocus, end: ZoomFocus, amount: number): ZoomFocus {
	return {
		cx: lerp(start.cx, end.cx, amount),
		cy: lerp(start.cy, end.cy, amount),
	};
}

interface ViewportRatio {
	widthRatio: number;
	heightRatio: number;
}

function getResolvedFocus(
	region: ZoomRegion,
	zoomScale: number,
	timeMs?: number,
	cursorTelemetry?: CursorTelemetryPoint[],
	viewportRatio?: ViewportRatio,
): ZoomFocus {
	let focus = region.focus;

	if (
		region.focusMode === "auto" &&
		cursorTelemetry &&
		cursorTelemetry.length > 0 &&
		timeMs !== undefined
	) {
		const cursorFocus = interpolateCursorAt(cursorTelemetry, timeMs);
		if (cursorFocus) {
			focus = cursorFocus;
		}
	}

	return clampFocusToScale(focus, zoomScale, viewportRatio);
}

function getConnectedRegionPairs(regions: ZoomRegion[]) {
	const sortedRegions = [...regions].sort((a, b) => a.startMs - b.startMs);
	const pairs: ConnectedRegionPair[] = [];

	for (let index = 0; index < sortedRegions.length - 1; index += 1) {
		const currentRegion = sortedRegions[index];
		const nextRegion = sortedRegions[index + 1];
		// LENSMITH: was a 1500 ms time-gap rule; now only a region marked connect: true chains.
		if (!isConnected(currentRegion)) {
			continue;
		}

		pairs.push({
			currentRegion,
			nextRegion,
			transitionStart: currentRegion.endMs,
			transitionEnd: currentRegion.endMs + CONNECTED_ZOOM_PAN_DURATION_MS,
		});
	}

	return pairs;
}

function getActiveRegion(
	regions: ZoomRegion[],
	timeMs: number,
	connectedPairs: ConnectedRegionPair[],
	cursorTelemetry?: CursorTelemetryPoint[],
	viewportRatio?: ViewportRatio,
) {
	const activeRegions = regions
		.map((region) => {
			const outgoingPair = connectedPairs.find((pair) => pair.currentRegion.id === region.id);
			if (outgoingPair && timeMs > outgoingPair.currentRegion.endMs) {
				return { region, strength: 0 };
			}

			const incomingPair = connectedPairs.find((pair) => pair.nextRegion.id === region.id);
			if (incomingPair && timeMs < incomingPair.transitionEnd) {
				return { region, strength: 0 };
			}

			return { region, strength: computeRegionStrength(region, timeMs) };
		})
		.filter((entry) => entry.strength > 0)
		.sort((left, right) => {
			if (right.strength !== left.strength) {
				return right.strength - left.strength;
			}

			return right.region.startMs - left.region.startMs;
		});

	if (activeRegions.length === 0) {
		return null;
	}

	const activeRegion = activeRegions[0].region;
	const activeScale = getZoomScale(activeRegion);

	return {
		region: {
			...activeRegion,
			focus: getResolvedFocus(activeRegion, activeScale, timeMs, cursorTelemetry, viewportRatio),
		},
		strength: activeRegions[0].strength,
		blendedScale: null,
		rotation3D: getRotation3D(activeRegion),
	};
}

function getConnectedRegionHold(
	timeMs: number,
	connectedPairs: ConnectedRegionPair[],
	cursorTelemetry?: CursorTelemetryPoint[],
	viewportRatio?: ViewportRatio,
) {
	for (const pair of connectedPairs) {
		if (timeMs > pair.transitionEnd && timeMs < pair.nextRegion.startMs) {
			const nextScale = getZoomScale(pair.nextRegion);
			return {
				region: {
					...pair.nextRegion,
					focus: getResolvedFocus(
						pair.nextRegion,
						nextScale,
						timeMs,
						cursorTelemetry,
						viewportRatio,
					),
				},
				strength: 1,
				blendedScale: null,
				rotation3D: getRotation3D(pair.nextRegion),
			};
		}
	}

	return null;
}

function getConnectedRegionTransition(
	connectedPairs: ConnectedRegionPair[],
	timeMs: number,
	cursorTelemetry?: CursorTelemetryPoint[],
	viewportRatio?: ViewportRatio,
) {
	for (const pair of connectedPairs) {
		const { currentRegion, nextRegion, transitionStart, transitionEnd } = pair;

		if (timeMs < transitionStart || timeMs > transitionEnd) {
			continue;
		}

		const transitionProgress = easeConnectedPan(
			clamp01((timeMs - transitionStart) / Math.max(1, transitionEnd - transitionStart)),
		);
		const currentScale = getZoomScale(currentRegion);
		const nextScale = getZoomScale(nextRegion);
		const transitionScale = lerp(currentScale, nextScale, transitionProgress);
		// Both regions share the same timeMs, so interpolate cursor once and reuse.
		const sharedCursorFocus =
			cursorTelemetry && cursorTelemetry.length > 0
				? interpolateCursorAt(cursorTelemetry, timeMs)
				: null;
		const currentFocus = clampFocusToScale(
			currentRegion.focusMode === "auto" && sharedCursorFocus
				? sharedCursorFocus
				: currentRegion.focus,
			currentScale,
			viewportRatio,
		);
		const nextFocus = clampFocusToScale(
			nextRegion.focusMode === "auto" && sharedCursorFocus ? sharedCursorFocus : nextRegion.focus,
			nextScale,
			viewportRatio,
		);
		const transitionFocus = getLinearFocus(currentFocus, nextFocus, transitionProgress);
		const transitionRotation = lerpRotation3D(
			getRotation3D(currentRegion),
			getRotation3D(nextRegion),
			transitionProgress,
		);

		return {
			region: {
				...nextRegion,
				focus: transitionFocus,
			},
			strength: 1,
			blendedScale: transitionScale,
			rotation3D: transitionRotation,
			transition: {
				progress: transitionProgress,
				startFocus: currentFocus,
				endFocus: nextFocus,
				startScale: currentScale,
				endScale: nextScale,
			},
		};
	}

	return null;
}

type DominantRegionResult = {
	region: ZoomRegion | null;
	strength: number;
	blendedScale: number | null;
	rotation3D: Rotation3D;
	transition: ConnectedPanTransition | null;
};

// Single-slot cache: the ticker calls findDominantRegion at 60fps with mostly
// unchanged inputs (especially while paused), so reusing the last result skips
// the per-frame O(N) scan and allocations.
let dominantRegionCache: {
	regions: ZoomRegion[];
	timeMsKey: number;
	telemetry: CursorTelemetryPoint[] | undefined;
	connectZooms: boolean;
	viewportRatio: ViewportRatio | undefined;
	result: DominantRegionResult;
} | null = null;

export function findDominantRegion(
	regions: ZoomRegion[],
	timeMs: number,
	options: DominantRegionOptions = {},
): DominantRegionResult {
	const connectZooms = !!options.connectZooms;
	const telemetry = options.cursorTelemetry;
	const vr = options.viewportRatio;
	const timeMsKey = Math.round(timeMs);

	if (
		dominantRegionCache &&
		dominantRegionCache.regions === regions &&
		dominantRegionCache.timeMsKey === timeMsKey &&
		dominantRegionCache.telemetry === telemetry &&
		dominantRegionCache.connectZooms === connectZooms &&
		dominantRegionCache.viewportRatio === vr
	) {
		return dominantRegionCache.result;
	}

	const connectedPairs = connectZooms ? getConnectedRegionPairs(regions) : [];

	let result: DominantRegionResult;
	if (connectZooms) {
		const connectedTransition = getConnectedRegionTransition(connectedPairs, timeMs, telemetry, vr);
		if (connectedTransition) {
			result = connectedTransition;
		} else {
			const connectedHold = getConnectedRegionHold(timeMs, connectedPairs, telemetry, vr);
			if (connectedHold) {
				result = { ...connectedHold, transition: null };
			} else {
				const activeRegion = getActiveRegion(regions, timeMs, connectedPairs, telemetry, vr);
				result = activeRegion
					? { ...activeRegion, transition: null }
					: {
							region: null,
							strength: 0,
							blendedScale: null,
							rotation3D: DEFAULT_ROTATION_3D,
							transition: null,
						};
			}
		}
	} else {
		const activeRegion = getActiveRegion(regions, timeMs, connectedPairs, telemetry, vr);
		result = activeRegion
			? { ...activeRegion, transition: null }
			: {
					region: null,
					strength: 0,
					blendedScale: null,
					rotation3D: DEFAULT_ROTATION_3D,
					transition: null,
				};
	}

	dominantRegionCache = {
		regions,
		timeMsKey,
		telemetry,
		connectZooms,
		viewportRatio: vr,
		result,
	};

	return result;
}
