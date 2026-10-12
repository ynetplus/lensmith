/**
 * Verbatim TypeScript port of OpenScreen's auto-zoom decision layer.
 *
 * Source: `src/components/video-editor/timeline/zoomSuggestionUtils.ts`
 * (github.com/siddharthvaddem/openscreen, MIT, © 2025 Siddharth Vaddem),
 * pinned commit `f57e36e25448b5af6c7b1b271066fe5beb9b8a49` — see `NOTICE.md`
 * for the full attribution and reuse map (CR-LENSMITH-A001-3).
 *
 * Logic and constants are unchanged from upstream. This CR ports only the
 * pure-math decision layer (no DOM/Electron dependency) plus the minimal
 * subset of upstream's `types.ts` (`ZoomFocus`, `ZoomRegion`,
 * `CursorTelemetryPoint`) this CLI actually produces/consumes — the full
 * `EditorProjectData` schema is CR-LENSMITH-A001-4's concern.
 */

/** Subset of upstream `types.ts` `CursorTelemetryPoint` (lines 178-193). */
export interface CursorTelemetryPoint {
	timeMs: number;
	cx: number;
	cy: number;
}

/** Upstream `types.ts` `ZoomFocus` (lines 29-32). */
export interface ZoomFocus {
	cx: number; // normalized horizontal center (0-1)
	cy: number; // normalized vertical center (0-1)
}

/** Upstream `types.ts` `ZoomDepth` (line 3). */
export type ZoomDepth = 1 | 2 | 3 | 4 | 5 | 6;

/** Upstream `types.ts` `ZoomRegionSource` (lines 64-69). */
export type ZoomRegionSource = "auto" | "manual";

/** Subset of upstream `types.ts` `ZoomRegion` (lines 71-82) this CLI produces. */
export interface ZoomRegion {
	id: string;
	startMs: number;
	endMs: number;
	depth: ZoomDepth;
	focus: ZoomFocus;
	customScale?: number;
	source?: ZoomRegionSource;
}

export const MIN_DWELL_DURATION_MS = 450;
export const MAX_DWELL_DURATION_MS = 2600;
export const DWELL_MOVE_THRESHOLD = 0.02;
/** Minimum spacing between two accepted suggestion centres. */
export const SUGGESTION_SPACING_MS = 1800;

export interface ZoomDwellCandidate {
	centerTimeMs: number;
	focus: ZoomFocus;
	strength: number;
}

function normalizeTelemetrySample(
	sample: CursorTelemetryPoint,
	totalMs: number,
): CursorTelemetryPoint {
	return {
		timeMs: Math.max(0, Math.min(sample.timeMs, totalMs)),
		cx: Math.max(0, Math.min(sample.cx, 1)),
		cy: Math.max(0, Math.min(sample.cy, 1)),
	};
}

export function normalizeCursorTelemetry(
	telemetry: CursorTelemetryPoint[],
	totalMs: number,
): CursorTelemetryPoint[] {
	return [...telemetry]
		.filter(
			(sample) =>
				Number.isFinite(sample.timeMs) && Number.isFinite(sample.cx) && Number.isFinite(sample.cy),
		)
		.sort((a, b) => a.timeMs - b.timeMs)
		.map((sample) => normalizeTelemetrySample(sample, totalMs));
}

export function detectZoomDwellCandidates(samples: CursorTelemetryPoint[]): ZoomDwellCandidate[] {
	if (samples.length < 2) {
		return [];
	}

	const dwellCandidates: ZoomDwellCandidate[] = [];
	let runStart = 0;

	const pushRunIfDwell = (startIndex: number, endIndexExclusive: number) => {
		if (endIndexExclusive - startIndex < 2) {
			return;
		}

		const start = samples[startIndex];
		const end = samples[endIndexExclusive - 1];
		// Guard is unreachable given the endIndexExclusive - startIndex >= 2
		// check above — required only to satisfy this repo's tsconfig
		// noUncheckedIndexedAccess (upstream's tsconfig lacks it).
		if (start === undefined || end === undefined) {
			return;
		}
		const runDuration = end.timeMs - start.timeMs;
		if (runDuration < MIN_DWELL_DURATION_MS || runDuration > MAX_DWELL_DURATION_MS) {
			return;
		}

		const runSamples = samples.slice(startIndex, endIndexExclusive);
		const avgCx = runSamples.reduce((sum, sample) => sum + sample.cx, 0) / runSamples.length;
		const avgCy = runSamples.reduce((sum, sample) => sum + sample.cy, 0) / runSamples.length;

		dwellCandidates.push({
			centerTimeMs: Math.round((start.timeMs + end.timeMs) / 2),
			focus: { cx: avgCx, cy: avgCy },
			strength: runDuration,
		});
	};

	for (let index = 1; index < samples.length; index += 1) {
		const prev = samples[index - 1];
		const curr = samples[index];
		// Guard is unreachable given the loop bounds (index runs 1..length-1) —
		// required only to satisfy noUncheckedIndexedAccess, see above.
		if (prev === undefined || curr === undefined) {
			continue;
		}
		const distance = Math.hypot(curr.cx - prev.cx, curr.cy - prev.cy);

		if (distance > DWELL_MOVE_THRESHOLD) {
			pushRunIfDwell(runStart, index);
			runStart = index;
		}
	}
	pushRunIfDwell(runStart, samples.length);

	return dwellCandidates;
}

export interface AutoZoomSuggestion {
	span: { start: number; end: number };
	focus: ZoomFocus;
}

/**
 * Build non-overlapping zoom suggestions from cursor telemetry: detect dwell moments,
 * rank by duration, space by SUGGESTION_SPACING_MS, drop any overlapping an existing
 * region. Pure, shared by the magic-wand toggle and the on-load auto-suggest pass.
 */
export function buildAutoZoomSuggestions(options: {
	cursorTelemetry: CursorTelemetryPoint[];
	totalMs: number;
	existingRegions: { startMs: number; endMs: number }[];
	defaultDurationMs: number;
}): AutoZoomSuggestion[] {
	const { cursorTelemetry, totalMs, existingRegions, defaultDurationMs } = options;
	if (totalMs <= 0 || cursorTelemetry.length < 2) {
		return [];
	}

	const defaultDuration = Math.min(defaultDurationMs, totalMs);
	if (defaultDuration <= 0) {
		return [];
	}

	const normalizedSamples = normalizeCursorTelemetry(cursorTelemetry, totalMs);
	if (normalizedSamples.length < 2) {
		return [];
	}

	const dwellCandidates = detectZoomDwellCandidates(normalizedSamples);
	if (dwellCandidates.length === 0) {
		return [];
	}

	const reservedSpans = existingRegions
		.map((region) => ({ start: region.startMs, end: region.endMs }))
		.sort((a, b) => a.start - b.start);

	const sortedCandidates = [...dwellCandidates].sort((a, b) => b.strength - a.strength);
	const acceptedCenters: number[] = [];
	const suggestions: AutoZoomSuggestion[] = [];

	for (const candidate of sortedCandidates) {
		const tooCloseToAccepted = acceptedCenters.some(
			(center) => Math.abs(center - candidate.centerTimeMs) < SUGGESTION_SPACING_MS,
		);
		if (tooCloseToAccepted) {
			continue;
		}

		const centeredStart = Math.round(candidate.centerTimeMs - defaultDuration / 2);
		const candidateStart = Math.max(0, Math.min(centeredStart, totalMs - defaultDuration));
		const candidateEnd = candidateStart + defaultDuration;
		const hasOverlap = reservedSpans.some(
			(span) => candidateEnd > span.start && candidateStart < span.end,
		);
		if (hasOverlap) {
			continue;
		}

		reservedSpans.push({ start: candidateStart, end: candidateEnd });
		acceptedCenters.push(candidate.centerTimeMs);
		suggestions.push({
			span: { start: candidateStart, end: candidateEnd },
			focus: candidate.focus,
		});
	}

	return suggestions;
}
