/**
 * Vendored verbatim from OpenScreen (MIT, (c) 2025 Siddharth Vaddem).
 * Source: https://github.com/siddharthvaddem/openscreen
 * Commit: f57e36e25448b5af6c7b1b271066fe5beb9b8a49 (2026-06-16)
 * Path (upstream): src/components/video-editor/videoPlayback/constants.ts
 * See NOTICE.md. Unmodified except where noted inline with "LENSMITH:".
 */
import type { ZoomFocus } from "../types";

export const DEFAULT_FOCUS: ZoomFocus = { cx: 0.5, cy: 0.5 };
// LENSMITH: CR-LENSMITH-A007-9 "Settle" pacing block (Pacing card, ratified by Drew
// 2026-10-11; values are provisional until locked after the review film). All
// zoom timing lives here so the lock step can freeze it in one place.
// Upstream values were: TRANSITION_WINDOW_MS = 1015.05 (zoom out),
// ZOOM_IN_TRANSITION_WINDOW_MS = TRANSITION_WINDOW_MS * 1.5 (= 1522.6),
// connected pan 1000 (was in zoomRegionUtils.ts), curve (0.16, 1, 0.3, 1).
export const TRANSITION_WINDOW_MS = 700; // LENSMITH: zoom out, was 1015.05
export const ZOOM_IN_TRANSITION_WINDOW_MS = 900; // LENSMITH: zoom in, was TRANSITION_WINDOW_MS * 1.5
export const CONNECTED_ZOOM_PAN_DURATION_MS = 700; // LENSMITH: moved here, was 1000
// LENSMITH: one curve for zoom in, zoom out and pan: cubic-bezier(0.4, 0, 0.2, 1)
// (was (0.16, 1, 0.3, 1) for in/out and (0.1, 0, 0.2, 1) for the pan).
export const SETTLE_CURVE = { x1: 0.4, y1: 0, x2: 0.2, y2: 1 } as const;
export const MIN_DELTA = 0.0001;
export const VIEWPORT_SCALE = 0.8;
export const SMOOTHING_FACTOR = 0.12;
export const ZOOM_TRANSLATION_DEADZONE_PX = 1.25;
export const ZOOM_SCALE_DEADZONE = 0.002;
export const AUTO_FOLLOW_SMOOTHING_FACTOR = 0.1;
export const AUTO_FOLLOW_SMOOTHING_FACTOR_MAX = 0.25;
export const AUTO_FOLLOW_RAMP_DISTANCE = 0.15;
// Reference frame interval so preview and export normalize their per-frame
// smoothing identically regardless of render fps. Lower fps = floatier follow
// (tuned to the live-preview feel).
export const AUTO_FOLLOW_REFERENCE_MS = 1000 / 40;
// Shared by preview and export so the camera follows the cursor identically.
export const AUTO_FOLLOW_PARAMS = {
	minFactor: AUTO_FOLLOW_SMOOTHING_FACTOR,
	maxFactor: AUTO_FOLLOW_SMOOTHING_FACTOR_MAX,
	rampDistance: AUTO_FOLLOW_RAMP_DISTANCE,
	referenceMs: AUTO_FOLLOW_REFERENCE_MS,
} as const;
