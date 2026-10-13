import { type ChildProcessByStdio, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { CursorTelemetryRecorder, type ShapeAssetPayload } from "./cursorTelemetry.js";
import {
	resolveCursorHelperPath,
	resolvePositionHelperPath,
	resolveScreenCaptureKitHelperPath,
} from "./nativeHelpers.js";
import { readNdjson } from "./ndjson.js";
import {
	buildRecordingRequest,
	captureCeiling,
	InvalidSourceError,
	parseSourceFlag,
	REGION_SOURCE_PATTERN,
} from "./recordingRequest.js";
import { deriveCursorJsonPath, deriveSessionJsonPath } from "./recordPaths.js";

export interface RecordCliOptions {
	source: string;
	fps: number;
	mic: boolean;
	systemAudio: boolean;
	out: string;
}

export interface HelperPaths {
	positionHelperPath: string;
	cursorHelperPath: string;
	sckHelperPath: string;
}

export interface RecordSessionIO {
	spawnFn?: typeof spawn;
	log?: (message: string) => void;
	errorLog?: (message: string) => void;
	/** Recording-start timestamp — also becomes `.session.json`'s `createdAt`. Injectable for tests. */
	startTimeMs?: number;
	/** How the caller is told to stop the recording (SIGINT by default — Ctrl+C). Injectable for tests. */
	stopSignal?: NodeJS.Signals;
	readyTimeoutMs?: number;
	/** Resolves the 3 native helper binaries. Defaults to the real `bin/` lookup
	 *  (nativeHelpers.ts) — overridable so tests don't depend on compiled binaries existing. */
	resolvePaths?: () => HelperPaths;
	/** Wall clock used to measure the recorded span (BF-24). Injectable for tests. */
	now?: () => number;
}

/** BF-24: how far the written film may drift from the measured span before the CLI warns. */
export const DURATION_MISMATCH_TOLERANCE_MS = 500;

/**
 * BF-24 tripwire: the helper's reported film duration against the span the session measured
 * (recording start to the stop request). Returns the warning to print, or null when they agree
 * within {@link DURATION_MISMATCH_TOLERANCE_MS}. A warning, never a failure.
 */
export function durationMismatchWarning(filmMs: number, spanMs: number): string | null {
	if (Math.abs(filmMs - spanMs) <= DURATION_MISMATCH_TOLERANCE_MS) {
		return null;
	}
	return (
		`[lensmith] WARNING: the film is ${Math.round(filmMs)} ms long but the recording spanned ` +
		`${Math.round(spanMs)} ms (off by ${Math.round(Math.abs(filmMs - spanMs))} ms). ` +
		"Timing laid on this film (captions, narration, zooms) may not line up."
	);
}

function resolveRealHelperPaths(): HelperPaths {
	return {
		positionHelperPath: resolvePositionHelperPath(),
		cursorHelperPath: resolveCursorHelperPath(),
		sckHelperPath: resolveScreenCaptureKitHelperPath(),
	};
}

type ChildWithStdin = ChildProcessByStdio<Writable, Readable, Readable>;
type ChildNoStdin = ChildProcessByStdio<null, Readable, Readable>;
type AnyHelperChild = ChildWithStdin | ChildNoStdin;

const READY_TIMEOUT_MS = 5_000;

function waitForReady<T>(
	child: AnyHelperChild,
	label: string,
	match: (event: unknown) => T | undefined,
	timeoutMs: number,
): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`Timed out waiting for ${label} to start.`));
		}, timeoutMs);

		readNdjson(child.stdout, (event) => {
			if (settled) return;
			const result = match(event);
			if (result !== undefined) {
				settled = true;
				clearTimeout(timer);
				resolve(result);
			}
		});

		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`${label} exited before becoming ready (code=${code}, signal=${signal}).`));
		});
	});
}

function killQuietly(child: AnyHelperChild | null): void {
	if (child && !child.killed) {
		child.kill("SIGTERM");
	}
}

/**
 * Runs `lensmith record` end to end: spawns the vendored ScreenCaptureKit +
 * cursor helpers and Lensmith's own position helper, merges their NDJSON
 * output, and writes `<out>`, `<out>.cursor.json`, `<out-base>.session.json`
 * on a clean stop. Returns the process exit code — callers set
 * `process.exitCode` from it rather than calling `process.exit()` directly,
 * so pending stream/child-process handles get to close naturally.
 */
export async function runRecord(
	options: RecordCliOptions,
	io: RecordSessionIO = {},
): Promise<number> {
	const spawnFn = io.spawnFn ?? spawn;
	const log = io.log ?? ((message: string) => console.log(message));
	const errorLog = io.errorLog ?? ((message: string) => console.error(message));
	const startTimeMs = io.startTimeMs ?? Date.now();
	const stopSignal = io.stopSignal ?? "SIGINT";
	const readyTimeoutMs = io.readyTimeoutMs ?? READY_TIMEOUT_MS;
	const now = io.now ?? Date.now;

	if (process.platform !== "darwin") {
		errorLog(
			"[lensmith] `record` requires macOS (ScreenCaptureKit) — this platform is not supported in v1.",
		);
		return 1;
	}

	const resolvePaths = io.resolvePaths ?? resolveRealHelperPaths;
	let positionHelperPath: string;
	let cursorHelperPath: string;
	let sckHelperPath: string;
	try {
		({ positionHelperPath, cursorHelperPath, sckHelperPath } = resolvePaths());
	} catch (error) {
		errorLog(`[lensmith] ${(error as Error).message}`);
		return 1;
	}

	const windowMatch = /^window:(\d+)$/.exec(options.source);
	// CR-LENSMITH-A010-7: a region source records a rectangle of the main display, so the
	// position helper tracks the display (no windowId) and telemetry normalises to the region.
	const regionMatch = REGION_SOURCE_PATTERN.exec(options.source);
	const positionChild = spawnFn(
		positionHelperPath,
		[
			JSON.stringify({
				sampleIntervalMs: 16,
				...(windowMatch ? { windowId: Number(windowMatch[1]) } : {}),
			}),
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	) as ChildNoStdin;

	let positionReady: {
		displayId: number;
		bounds: { x: number; y: number; width: number; height: number };
		pixelWidth: number;
		pixelHeight: number;
		windowFrame?: { x: number; y: number; width: number; height: number };
	};
	try {
		positionReady = await waitForReady(
			positionChild,
			"the cursor position helper",
			(event) => {
				const e = event as Record<string, unknown>;
				if (e?.type !== "ready") return undefined;
				return {
					displayId: e.displayId as number,
					bounds: e.bounds as { x: number; y: number; width: number; height: number },
					pixelWidth: e.pixelWidth as number,
					pixelHeight: e.pixelHeight as number,
					windowFrame: e.windowFrame as
						| { x: number; y: number; width: number; height: number }
						| undefined,
				};
			},
			readyTimeoutMs,
		);
	} catch (error) {
		errorLog(`[lensmith] ${(error as Error).message}`);
		killQuietly(positionChild);
		return 1;
	}

	let source: ReturnType<typeof parseSourceFlag>;
	try {
		source = parseSourceFlag(options.source, positionReady.displayId);
	} catch (error) {
		if (error instanceof InvalidSourceError) {
			errorLog(`[lensmith] ${error.message}`);
		} else {
			errorLog(`[lensmith] ${(error as Error).message}`);
		}
		killQuietly(positionChild);
		return 1;
	}

	const screenPath = path.resolve(options.out);
	const cursorJsonPath = deriveCursorJsonPath(screenPath);
	const sessionJsonPath = deriveSessionJsonPath(screenPath);

	// Pixels-per-point for the main display (e.g. 2 on Retina) — fallback for a cursor
	// asset's scaleFactor on the rare event the helper's own payload omits it, mirroring
	// upstream's screen.getDisplayNearestPoint(cursor).scaleFactor fallback (see
	// cursorTelemetry.ts). The helper always includes its own scaleFactor in practice, so
	// this is a defensive parity fallback, not the primary source.
	const displayScaleFactor = positionReady.pixelWidth / Math.max(1, positionReady.bounds.width);
	if (windowMatch && !positionReady.windowFrame) {
		errorLog(
			`[lensmith] Warning: no frame reported for window ${windowMatch[1]}; cursor positions fall back to display bounds.`,
		);
	}
	// Region bounds are main-display points; offset by the display origin so they share the
	// position helper's global coordinate space (the main display's origin is 0,0 in practice).
	const regionBounds = regionMatch
		? {
				x: positionReady.bounds.x + Number(regionMatch[1]),
				y: positionReady.bounds.y + Number(regionMatch[2]),
				width: Number(regionMatch[3]),
				height: Number(regionMatch[4]),
			}
		: undefined;
	const telemetry = new CursorTelemetryRecorder(
		startTimeMs,
		// BF-19: a window source's video is the window only, so normalize to its frame.
		// CR-LENSMITH-A010-7: a region source's video is the region only, so normalize to it.
		regionBounds ??
			(windowMatch && positionReady.windowFrame ? positionReady.windowFrame : positionReady.bounds),
		displayScaleFactor,
	);
	readNdjson(positionChild.stdout, (event) => {
		const e = event as Record<string, unknown>;
		if (e?.type === "sample" && typeof e.x === "number" && typeof e.y === "number") {
			telemetry.recordPosition(e.x, e.y);
		} else if (e?.type === "windowFrame" && e.frame && windowMatch) {
			telemetry.setBounds(e.frame as { x: number; y: number; width: number; height: number });
		}
	});

	const cursorChild = spawnFn(cursorHelperPath, [JSON.stringify({ sampleIntervalMs: 33 })], {
		stdio: ["ignore", "pipe", "pipe"],
	}) as ChildNoStdin;

	let accessibilityWarningShown = false;
	readNdjson(cursorChild.stdout, (event) => {
		const e = event as Record<string, unknown>;
		if (e?.type === "ready") {
			if (e.accessibilityTrusted === false && !accessibilityWarningShown) {
				accessibilityWarningShown = true;
				log(
					"[lensmith] Accessibility permission is not yet granted — cursor bitmap capture will " +
						"still work, but text/pointer affordance detection is disabled. Grant it once via " +
						"System Settings > Privacy & Security > Accessibility, then re-run `lensmith record`.",
				);
			}
			return;
		}
		if (e?.type === "sample") {
			telemetry.recordShapeSample({
				timestampMs: e.timestampMs as number,
				assetId: (e.assetId as string | null | undefined) ?? null,
				// The helper only includes the (large, base64) `asset` payload the first time a
				// given cursor shape is seen — undefined/null on every later sample referencing
				// the same assetId, which `rememberAsset()` dedupes on anyway.
				asset: (e.asset as ShapeAssetPayload | null | undefined) ?? null,
				leftButtonDown: e.leftButtonDown === true,
				leftButtonPressed: e.leftButtonPressed === true,
				leftButtonReleased: e.leftButtonReleased === true,
			});
		}
	});

	const request = buildRecordingRequest({
		source,
		fps: options.fps,
		mic: options.mic,
		systemAudio: options.systemAudio,
		screenPath,
		...captureCeiling(positionReady),
	});

	const sckChild = spawnFn(sckHelperPath, [JSON.stringify(request)], {
		stdio: ["pipe", "pipe", "pipe"],
	}) as ChildWithStdin;

	const outcome = await new Promise<"stopped" | "error">((resolve) => {
		let settled = false;
		let stopRequested = false;
		let recordingStartedAtMs: number | null = null;
		let stopRequestedAtMs: number | null = null;

		const finish = (result: "stopped" | "error") => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		readNdjson(sckChild.stdout, (event) => {
			const e = event as Record<string, unknown>;
			if (e?.event === "ready") {
				log("[lensmith] Recording ready.");
				return;
			}
			if (e?.event === "recording-started") {
				recordingStartedAtMs = now();
				log(
					`[lensmith] Recording started (${e.width}x${e.height} @ ${options.fps}fps). ` +
						"Press Ctrl+C to stop.",
				);
				return;
			}
			if (e?.event === "warning") {
				log(`[lensmith] Warning: ${e.message}`);
				return;
			}
			if (e?.event === "error") {
				errorLog(`[lensmith] Recording failed: ${e.message}`);
				finish("error");
				return;
			}
			if (e?.event === "recording-stopped") {
				log("[lensmith] Recording stopped.");
				if (
					typeof e.durationMs === "number" &&
					recordingStartedAtMs !== null &&
					stopRequestedAtMs !== null
				) {
					const warning = durationMismatchWarning(
						e.durationMs,
						stopRequestedAtMs - recordingStartedAtMs,
					);
					if (warning) errorLog(warning);
				}
				finish("stopped");
			}
		});

		sckChild.stderr.on("data", (chunk: Buffer) => {
			const message = chunk.toString("utf8").trim();
			if (message) {
				errorLog(`[lensmith] ${message}`);
			}
		});

		sckChild.once("error", (error) => {
			errorLog(`[lensmith] Failed to start the ScreenCaptureKit helper: ${error.message}`);
			finish("error");
		});
		// 'close' (not 'exit'): Node only guarantees 'close' fires after the child's stdio streams
		// have finished delivering their data, so a "recording-stopped"/"error" NDJSON line already
		// in flight is guaranteed to have reached the readNdjson handler above — and settled `finish`
		// — before this listener runs. 'exit' carries no such ordering guarantee. Round 1 papered
		// over that race by trusting a bare `code === 0` as success on 'exit'; round 2 found that a
		// helper which fails to finalize the mp4 still exits 0, which made that trust a false-success
		// bug in its own right (BF-6). Reaching this point with `settled` still false now means the
		// helper genuinely never confirmed a completed write — never inferred from its exit code alone.
		sckChild.once("close", (code, signal) => {
			if (settled) return;
			errorLog(`[lensmith] Recording helper exited unexpectedly (code=${code}, signal=${signal}).`);
			finish("error");
		});

		const requestStop = () => {
			if (stopRequested || sckChild.killed || sckChild.exitCode !== null) {
				return;
			}
			stopRequested = true;
			stopRequestedAtMs = now();
			log("[lensmith] Stopping recording...");
			sckChild.stdin.write("stop\n");
		};

		process.once(stopSignal, requestStop);
	});

	killQuietly(cursorChild);
	killQuietly(positionChild);

	if (outcome === "error") {
		return 1;
	}

	const createdAt = startTimeMs;
	const telemetryData = telemetry.toTelemetryData();
	const sessionData = {
		screenVideoPath: screenPath,
		createdAt,
		cursorCaptureMode: "editable-overlay" as const,
	};

	await fs.writeFile(cursorJsonPath, JSON.stringify(telemetryData, null, 2));
	await fs.writeFile(sessionJsonPath, JSON.stringify(sessionData, null, 2));

	log(
		`[lensmith] Wrote ${screenPath}, ${path.basename(cursorJsonPath)}, ` +
			`${path.basename(sessionJsonPath)} (${telemetry.sampleCount} cursor samples).`,
	);

	return 0;
}
