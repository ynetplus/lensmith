import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import {
	buildAutoZoomSuggestions,
	type CursorTelemetryPoint,
	type ZoomRegion,
} from "../lib/zoomSuggestion.js";

/** Real value reverse-engineered this session from Drew's saved `.openscreen` project. */
const DEFAULT_DURATION_MS = 3033;

/** Depth 3 matches upstream's `1.8x` / `customScale: 1.8` default (see Drew's saved project). */
const DEFAULT_ZOOM_DEPTH = 3;
const DEFAULT_CUSTOM_SCALE = 1.8;

interface CursorTelemetryFile {
	version: number;
	provider: string;
	samples: CursorTelemetryPoint[];
}

function parsePositiveInt(value: string, flagName: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
		throw new Error(`${flagName} must be a positive integer (got "${value}")`);
	}
	return parsed;
}

function readCursorTelemetry(cursorPath: string): CursorTelemetryPoint[] {
	let raw: string;
	try {
		raw = readFileSync(cursorPath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`could not read cursor telemetry file "${cursorPath}": ${message}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`"${cursorPath}" is not valid JSON: ${message}`);
	}

	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!Array.isArray((parsed as CursorTelemetryFile).samples)
	) {
		throw new Error(
			`"${cursorPath}" does not look like a .cursor.json telemetry file — expected an object with a "samples" array`,
		);
	}

	return (parsed as CursorTelemetryFile).samples;
}

/**
 * Run the auto-zoom decision layer over real cursor telemetry and write the
 * result. Exposed separately from `registerSuggestZoomsCommand` so it can be
 * unit-tested without spawning a subprocess (the fixture-comparison test —
 * CR-LENSMITH-A001-3's Acceptance Metric — calls this directly).
 */
export function runSuggestZooms(options: {
	cursorPath: string;
	durationMs: number;
	defaultDurationMs: number;
}): { zoomRegions: ZoomRegion[] } {
	const samples = readCursorTelemetry(options.cursorPath);

	const suggestions = buildAutoZoomSuggestions({
		cursorTelemetry: samples,
		totalMs: options.durationMs,
		existingRegions: [],
		defaultDurationMs: options.defaultDurationMs,
	});

	// Chronological order (by start time) — deterministic, independent of the
	// internal strength-ranked acceptance order buildAutoZoomSuggestions uses.
	const chronological = [...suggestions].sort((a, b) => a.span.start - b.span.start);

	const zoomRegions: ZoomRegion[] = chronological.map((suggestion, index) => ({
		id: `auto-${index + 1}`,
		startMs: suggestion.span.start,
		endMs: suggestion.span.end,
		depth: DEFAULT_ZOOM_DEPTH,
		customScale: DEFAULT_CUSTOM_SCALE,
		focus: suggestion.focus,
		source: "auto",
	}));

	return { zoomRegions };
}

/**
 * `lensmith suggest-zooms` — auto-zoom region detection, a verbatim port
 * of OpenScreen's `zoomSuggestionUtils.ts` (see `src/lib/zoomSuggestion.ts`
 * and `NOTICE.md`). CR-LENSMITH-A001-3.
 */
export function registerSuggestZoomsCommand(program: Command): void {
	program
		.command("suggest-zooms")
		.description("Suggest auto-zoom regions from cursor telemetry")
		.requiredOption("--cursor <path>", "path to a .cursor.json telemetry file (from `record`)")
		.requiredOption("--duration-ms <n>", "total recording duration in milliseconds")
		.option(
			"--default-duration-ms <n>",
			"default zoom region duration in milliseconds",
			String(DEFAULT_DURATION_MS),
		)
		.requiredOption("--out <path>", "path to write the resulting zooms.json fragment")
		.action(
			(opts: { cursor: string; durationMs: string; defaultDurationMs: string; out: string }) => {
				try {
					const durationMs = parsePositiveInt(opts.durationMs, "--duration-ms");
					const defaultDurationMs = parsePositiveInt(
						opts.defaultDurationMs,
						"--default-duration-ms",
					);

					const result = runSuggestZooms({
						cursorPath: opts.cursor,
						durationMs,
						defaultDurationMs,
					});

					writeFileSync(opts.out, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
					console.log(`suggest-zooms: wrote ${result.zoomRegions.length} region(s) to ${opts.out}`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					console.error(`suggest-zooms: ${message}`);
					process.exitCode = 1;
				}
			},
		);
}
