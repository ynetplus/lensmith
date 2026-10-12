import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";

/**
 * `lensmith compose` — turns a `{ zoomRegions: [...] }` fragment (what
 * `suggest-zooms` writes) into a full `EditorProjectData` project file (what
 * `process` / `gif` read). CR-LENSMITH-A001-8.
 *
 * The schema below is transcribed field-for-field from a REAL project saved by
 * OpenScreen's own GUI — `tests/fixtures/recording-1786461836877.openscreen`,
 * which is the ground truth for this format (not any prose description of it).
 * Every default value here is that fixture's own value, so a default `compose`
 * run reproduces the hand-made project exactly, modulo the flags this command
 * deliberately exposes.
 *
 * Schema provenance: OpenScreen (MIT, © 2025 Siddharth Vaddem) —
 * `src/lib/projectPersistence.ts` upstream; see `NOTICE.md`.
 */

/** Fixture's own values — the "author it like the GUI did" defaults. */
export const COMPOSE_DEFAULTS = {
	aspectRatio: "16:9",
	exportQuality: "good",
	padding: 50,
	wallpaper: "/wallpapers/wallpaper1.jpg",
	borderRadius: 0,
	shadowIntensity: 0,
} as const;

/**
 * Upstream's `ASPECT_RATIOS` union, kept as a local literal because the CLI's
 * tsconfig excludes `vendor/` (only the browser-side harness bundle resolves
 * `@/`). Source of truth: `vendor/openscreen/src/utils/aspectRatioUtils.ts`.
 */
const VALID_ASPECT_RATIOS = [
	"16:9",
	"9:16",
	"1:1",
	"4:3",
	"4:5",
	"16:10",
	"10:16",
	"native",
] as const;

/** Upstream's `ExportQuality` union — `vendor/openscreen/src/lib/exporter/mp4ExportSettings.ts`. */
const VALID_EXPORT_QUALITIES = ["medium", "good", "source"] as const;

export type AspectRatioValue = (typeof VALID_ASPECT_RATIOS)[number];
export type ExportQualityValue = (typeof VALID_EXPORT_QUALITIES)[number];

/** A zoom region as it appears on disk — passed through verbatim once validated. */
export interface ComposeZoomRegion {
	id: string;
	startMs: number;
	endMs: number;
	focus: { cx: number; cy: number };
	[key: string]: unknown;
}

/** Values applied to a zoom region that omits them (BF-13). */
const ZOOM_REGION_DEFAULTS = { depth: 3, customScale: 1.8, source: "auto" } as const;

export interface EditorProjectData {
	version: number;
	media: {
		screenVideoPath: string;
		cursorCaptureMode: string;
	};
	editor: Record<string, unknown>;
}

export interface ComposeOptions {
	zoomsPath: string;
	rawPath: string;
	aspectRatio?: string;
	exportQuality?: string;
	padding?: number;
	wallpaper?: string;
	borderRadius?: number;
	shadowIntensity?: number;
}

function readZoomFragment(zoomsPath: string): unknown {
	let raw: string;
	try {
		raw = readFileSync(zoomsPath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`could not read --zooms file "${zoomsPath}": ${message}`);
	}

	try {
		return JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`"${zoomsPath}" is not valid JSON: ${message}`);
	}
}

/** Human-readable name for an offending region: its id when it has one, else its index. */
function regionLabel(region: unknown, index: number): string {
	if (typeof region === "object" && region !== null) {
		const id = (region as { id?: unknown }).id;
		if (typeof id === "string" && id.length > 0) return `"${id}" (index ${index})`;
	}
	return `at index ${index}`;
}

/**
 * Validates the fragment and returns its regions. A malformed fragment throws
 * with a message naming the offending region — `compose` never writes a broken
 * project file (the whole point: `process` would render garbage or crash).
 */
export function validateZoomFragment(parsed: unknown, zoomsPath: string): ComposeZoomRegion[] {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(
			`"${zoomsPath}" does not look like a zooms fragment — expected an object with a "zoomRegions" array`,
		);
	}

	const regions = (parsed as { zoomRegions?: unknown }).zoomRegions;
	if (!Array.isArray(regions)) {
		throw new Error(
			`"${zoomsPath}" does not look like a zooms fragment — expected an object with a "zoomRegions" array`,
		);
	}

	const validated = regions.map((region, index) => {
		const label = regionLabel(region, index);

		if (typeof region !== "object" || region === null || Array.isArray(region)) {
			throw new Error(`zoom region ${label} is not an object`);
		}

		const { id, startMs, endMs, focus } = region as {
			id?: unknown;
			startMs?: unknown;
			endMs?: unknown;
			focus?: unknown;
		};

		if (typeof id !== "string" || id.length === 0) {
			throw new Error(`zoom region ${label} has a missing or empty "id"`);
		}
		if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
			throw new Error(`zoom region ${label} has a non-numeric "startMs"/"endMs"`);
		}
		if ((startMs as number) >= (endMs as number)) {
			throw new Error(
				`zoom region ${label} has startMs >= endMs (${String(startMs)} >= ${String(endMs)}) — a region must start before it ends`,
			);
		}
		if (typeof focus !== "object" || focus === null) {
			throw new Error(`zoom region ${label} has no "focus" object`);
		}
		const { cx, cy } = focus as { cx?: unknown; cy?: unknown };
		for (const [axis, value] of [
			["cx", cx],
			["cy", cy],
		] as const) {
			if (!Number.isFinite(value)) {
				throw new Error(`zoom region ${label} has a non-numeric "focus.${axis}"`);
			}
			if ((value as number) < 0 || (value as number) > 1) {
				throw new Error(
					`zoom region ${label} has "focus.${axis}" = ${String(value)} outside the normalized range 0..1`,
				);
			}
		}

		// BF-13: an engine that renders a region lacking depth/customScale draws only
		// the wallpaper, silently. Default them (with a warning) instead of passing
		// the gap through; a value that IS present but invalid is still an error.
		const filled: Record<string, unknown> = { ...(region as Record<string, unknown>) };
		const defaults: Array<[string, unknown, (v: unknown) => boolean, string]> = [
			["depth", ZOOM_REGION_DEFAULTS.depth, (v) => Number.isFinite(v), "a number"],
			[
				"customScale",
				ZOOM_REGION_DEFAULTS.customScale,
				(v) => Number.isFinite(v) && (v as number) > 0,
				"a positive number",
			],
			["source", ZOOM_REGION_DEFAULTS.source, (v) => typeof v === "string", "a string"],
		];
		for (const [field, fallback, isValid, expected] of defaults) {
			const present = filled[field];
			if (present === undefined || present === null) {
				filled[field] = fallback;
				// "source" has always defaulted quietly; only the render-critical fields warn.
				if (field !== "source") {
					process.stderr.write(
						`compose: zoom region ${id} had no ${field}, using ${String(fallback)}\n`,
					);
				}
			} else if (!isValid(present)) {
				throw new Error(
					`zoom region ${label} has an invalid "${field}" = ${JSON.stringify(present)} — expected ${expected}`,
				);
			}
		}
		return filled as ComposeZoomRegion;
	});

	return validated;
}

function validateChoice<T extends string>(
	value: string,
	allowed: readonly T[],
	flagName: string,
): T {
	if (!(allowed as readonly string[]).includes(value)) {
		throw new Error(`${flagName} must be one of: ${allowed.join(", ")} (got "${value}")`);
	}
	return value as T;
}

function parseNonNegativeNumber(value: string, flagName: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`${flagName} must be a non-negative number (got "${value}")`);
	}
	return parsed;
}

/**
 * Builds the `EditorProjectData` object. Exported separately from
 * `registerComposeCommand` so it can be unit-tested without spawning a
 * subprocess — the same split `suggestZooms.ts` uses (`runSuggestZooms`).
 *
 * `media.screenVideoPath` carries `--raw` exactly as given. The render path
 * does NOT read it: `process`/`gif` load the video from `--raw` and hand the
 * harness only `project.editor` (`src/commands/process.ts`,
 * `src/lib/harnessRunner.ts`) — verified empirically, see the
 * CR-LENSMITH-A001-8 forge report. Fabricating an absolute path here would
 * therefore invent provenance the tool cannot honour; the field stays a
 * faithful record of what the operator named on the command line.
 */
export function runCompose(options: ComposeOptions): EditorProjectData {
	const zoomRegions = validateZoomFragment(readZoomFragment(options.zoomsPath), options.zoomsPath);

	const aspectRatio = options.aspectRatio ?? COMPOSE_DEFAULTS.aspectRatio;
	const exportQuality = options.exportQuality ?? COMPOSE_DEFAULTS.exportQuality;

	return {
		version: 2,
		media: {
			screenVideoPath: options.rawPath,
			cursorCaptureMode: "editable-overlay",
		},
		editor: {
			wallpaper: options.wallpaper ?? COMPOSE_DEFAULTS.wallpaper,
			shadowIntensity: options.shadowIntensity ?? COMPOSE_DEFAULTS.shadowIntensity,
			showBlur: false,
			showTrimWaveform: true,
			motionBlurAmount: 0,
			borderRadius: options.borderRadius ?? COMPOSE_DEFAULTS.borderRadius,
			padding: options.padding ?? COMPOSE_DEFAULTS.padding,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
			zoomRegions,
			autoZoomEnabled: true,
			autoFocusAll: false,
			trimRegions: [],
			speedRegions: [],
			annotationRegions: [],
			aspectRatio,
			webcamLayoutPreset: "picture-in-picture",
			webcamMaskShape: "rectangle",
			webcamMirrored: false,
			webcamReactiveZoom: true,
			webcamSizePreset: 25,
			webcamPosition: null,
			exportQuality,
			exportFormat: "mp4",
			gifFrameRate: 15,
			gifLoop: true,
			gifSizePreset: "medium",
			cursorTheme: "default",
		},
	};
}

export function registerComposeCommand(program: Command): void {
	program
		.command("compose")
		.description("Compose a zooms fragment + a raw recording into a project file for `process`")
		.requiredOption(
			"--zooms <path>",
			"zooms.json fragment ({ zoomRegions: [...] }) from `suggest-zooms`",
		)
		.requiredOption("--raw <path>", "raw screen recording (.mp4) the project describes")
		.requiredOption("--out <path>", "path to write the resulting .openscreen project file")
		.option("--aspect <ratio>", "output aspect ratio", COMPOSE_DEFAULTS.aspectRatio)
		.option(
			"--quality <level>",
			"export quality (medium|good|source)",
			COMPOSE_DEFAULTS.exportQuality,
		)
		.option("--padding <n>", "padding around the video frame", String(COMPOSE_DEFAULTS.padding))
		.option("--wallpaper <path>", "wallpaper behind the video", COMPOSE_DEFAULTS.wallpaper)
		.option(
			"--border-radius <n>",
			"corner radius of the video frame",
			String(COMPOSE_DEFAULTS.borderRadius),
		)
		.option(
			"--shadow-intensity <n>",
			"drop-shadow intensity (0 disables the shadow)",
			String(COMPOSE_DEFAULTS.shadowIntensity),
		)
		.action(
			(opts: {
				zooms: string;
				raw: string;
				out: string;
				aspect: string;
				quality: string;
				padding: string;
				wallpaper: string;
				borderRadius: string;
				shadowIntensity: string;
			}) => {
				try {
					const project = runCompose({
						zoomsPath: opts.zooms,
						rawPath: opts.raw,
						aspectRatio: validateChoice(opts.aspect, VALID_ASPECT_RATIOS, "--aspect"),
						exportQuality: validateChoice(opts.quality, VALID_EXPORT_QUALITIES, "--quality"),
						padding: parseNonNegativeNumber(opts.padding, "--padding"),
						wallpaper: opts.wallpaper,
						borderRadius: parseNonNegativeNumber(opts.borderRadius, "--border-radius"),
						shadowIntensity: parseNonNegativeNumber(opts.shadowIntensity, "--shadow-intensity"),
					});

					writeFileSync(opts.out, `${JSON.stringify(project, null, 2)}\n`, "utf-8");
					const regionCount = (project.editor.zoomRegions as unknown[]).length;
					console.log(`compose: wrote ${opts.out} (${regionCount} zoom region(s))`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					console.error(`compose: ${message}`);
					process.exitCode = 1;
				}
			},
		);
}
