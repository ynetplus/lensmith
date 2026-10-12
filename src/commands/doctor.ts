import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { chromium } from "playwright";
import {
	resolveCursorHelperPath,
	resolvePositionHelperPath,
	resolveScreenCaptureKitHelperPath,
} from "../lib/nativeHelpers.js";

/**
 * `lensmith doctor [--json]` — one read-only call that tells an agent whether it can record
 * (CR-LENSMITH-A003-9). It never records and never triggers the macOS permission dialog:
 * the Screen Recording check uses `CGPreflightScreenCaptureAccess` (preflight only, never
 * `CGRequestScreenCaptureAccess`).
 *
 * Stable `code` strings (part of the agent contract):
 *   ok, not_macos, native_helpers_missing, screen_recording_denied, screen_locked,
 *   session_unavailable, ffmpeg_missing, chromium_missing, whisperx_missing, check_error.
 */

export type CheckId =
	| "platform_macos"
	| "native_helpers_built"
	| "screen_recording_permission"
	| "screen_unlocked"
	| "ffmpeg_present"
	| "chromium_for_render"
	| "whisperx_present";

export interface DoctorCheck {
	id: CheckId;
	required: boolean;
	ok: boolean;
	code: string;
	detail: string;
	fix: string | null;
}

export interface DoctorReport {
	ok: boolean;
	version: string;
	checks: DoctorCheck[];
}

/** Result of the CoreGraphics session probe. `locked: null` = no session info available. */
export interface ScreenState {
	permission: boolean;
	locked: boolean | null;
}

/** Injectable probes so the orchestration is unit-testable without a real Mac setup. */
export interface DoctorDeps {
	platform: NodeJS.Platform;
	version: () => string;
	/** Throws if any native helper is missing / not executable. */
	assertHelpersBuilt: () => void;
	/** Preflight-only (no dialog). */
	readScreenState: () => ScreenState;
	hasCommand: (cmd: string) => boolean;
	/** Path of the Playwright Chromium the render harness launches, if resolvable. */
	chromiumPath: () => string | undefined;
	fileExists: (p: string) => boolean;
}

// JXA bridges the two CoreGraphics C calls with no Swift build and no prompt:
// CGPreflightScreenCaptureAccess is preflight-only; CGSSessionScreenIsLocked is present in the
// session dictionary only while the screen is locked.
const SCREEN_STATE_SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]);
var session = ObjC.deepUnwrap($.CGSessionCopyCurrentDictionary());
JSON.stringify({
	permission: $.CGPreflightScreenCaptureAccess(),
	locked: session ? !!session.CGSSessionScreenIsLocked : null,
});
`;

function readScreenStateReal(): ScreenState {
	const result = spawnSync("osascript", ["-l", "JavaScript", "-e", SCREEN_STATE_SCRIPT], {
		encoding: "utf-8",
	});
	if (result.error || result.status !== 0) {
		throw new Error(result.error?.message ?? (result.stderr?.trim() || "osascript failed"));
	}
	const parsed = JSON.parse(result.stdout.trim()) as ScreenState;
	return { permission: parsed.permission === true, locked: parsed.locked };
}

function readPackageVersion(): string {
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const pkg = JSON.parse(readFileSync(path.join(here, "..", "..", "package.json"), "utf-8"));
		return typeof pkg.version === "string" ? pkg.version : "unknown";
	} catch {
		return "unknown";
	}
}

const realDeps: DoctorDeps = {
	platform: process.platform,
	version: readPackageVersion,
	assertHelpersBuilt: () => {
		resolveScreenCaptureKitHelperPath();
		resolveCursorHelperPath();
		resolvePositionHelperPath();
	},
	readScreenState: readScreenStateReal,
	hasCommand: (cmd) => !spawnSync(cmd, ["-version"], { stdio: "ignore" }).error,
	chromiumPath: () => chromium.executablePath(),
	fileExists: existsSync,
};

type Outcome = Pick<DoctorCheck, "ok" | "code" | "detail" | "fix">;

function runCheck(id: CheckId, required: boolean, probe: () => Outcome): DoctorCheck {
	try {
		return { id, required, ...probe() };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			id,
			required,
			ok: false,
			code: "check_error",
			detail: `Check threw: ${message}`,
			fix: "Re-run; if it persists, file an issue with this output.",
		};
	}
}

const pass = (detail: string): Outcome => ({ ok: true, code: "ok", detail, fix: null });

export function collectReport(deps: DoctorDeps): DoctorReport {
	const isMac = deps.platform === "darwin";
	const notMac = (): Outcome => ({
		ok: false,
		code: "not_macos",
		detail: `Not applicable on ${deps.platform}; recording needs macOS.`,
		fix: "Run Lensmith on a Mac.",
	});

	// One CoreGraphics read feeds both the permission and the lock checks.
	let screen: ScreenState | undefined;
	let screenError: unknown;
	if (isMac) {
		try {
			screen = deps.readScreenState();
		} catch (error) {
			screenError = error;
		}
	}
	const screenProbe = (use: (s: ScreenState) => Outcome): Outcome => {
		if (!isMac) return notMac();
		if (screenError) throw screenError;
		return use(screen as ScreenState);
	};

	const checks: DoctorCheck[] = [
		runCheck("platform_macos", true, () =>
			isMac
				? pass("macOS (darwin)")
				: {
						ok: false,
						code: "not_macos",
						detail: `Platform is ${deps.platform}; recording needs macOS.`,
						fix: "Run Lensmith on a Mac.",
					},
		),
		runCheck("native_helpers_built", true, () => {
			if (!isMac) return notMac();
			try {
				deps.assertHelpersBuilt();
			} catch (error) {
				return {
					ok: false,
					code: "native_helpers_missing",
					detail: error instanceof Error ? error.message : String(error),
					fix: "Run: npm run build:native:mac (needs Xcode / a full Swift toolchain).",
				};
			}
			return pass("All native helpers are built and executable.");
		}),
		runCheck("screen_recording_permission", true, () =>
			screenProbe((s) =>
				s.permission
					? pass("Screen Recording permission is granted (preflight, no prompt).")
					: {
							ok: false,
							code: "screen_recording_denied",
							detail: "Screen Recording permission is not granted to this terminal/app.",
							fix: "System Settings > Privacy & Security > Screen Recording: enable your terminal, then restart it.",
						},
			),
		),
		runCheck("screen_unlocked", true, () =>
			screenProbe((s) => {
				if (s.locked === null) {
					return {
						ok: false,
						code: "session_unavailable",
						detail: "No GUI login session is visible, so lock state cannot be determined.",
						fix: "Run from a logged-in desktop session (not a bare ssh/launchd context).",
					};
				}
				return s.locked
					? {
							ok: false,
							code: "screen_locked",
							detail: "The screen is locked; a recording would capture the lock screen.",
							fix: "Unlock the Mac and keep the display awake.",
						}
					: pass("Screen is unlocked.");
			}),
		),
		runCheck("ffmpeg_present", true, () =>
			deps.hasCommand("ffmpeg")
				? pass("ffmpeg found on PATH.")
				: {
						ok: false,
						code: "ffmpeg_missing",
						detail: "ffmpeg not found on PATH.",
						fix: "Install it: brew install ffmpeg",
					},
		),
		runCheck("chromium_for_render", true, () => {
			const exe = deps.chromiumPath();
			return exe && deps.fileExists(exe)
				? pass(`Playwright Chromium found at ${exe}`)
				: {
						ok: false,
						code: "chromium_missing",
						detail: "Playwright Chromium (used by process/gif rendering) is not installed.",
						fix: "Run: npx playwright install chromium",
					};
		}),
		runCheck("whisperx_present", false, () =>
			deps.hasCommand("whisperx")
				? pass("whisperx found on PATH.")
				: {
						ok: false,
						code: "whisperx_missing",
						detail: "whisperx not found on PATH (only needed for `lensmith caption`).",
						fix: "Install it: pip install whisperx",
					},
		),
	];

	return {
		ok: checks.every((c) => c.ok || !c.required),
		version: deps.version(),
		checks,
	};
}

export function formatTable(report: DoctorReport): string {
	const lines = report.checks.map((c) => {
		const mark = c.ok ? "ok  " : c.required ? "FAIL" : "warn";
		const line = `${mark}  ${c.id.padEnd(28)} ${c.code}`;
		return c.ok ? line : `${line}\n      ${c.detail}\n      fix: ${c.fix}`;
	});
	lines.push("", report.ok ? "Ready to record." : "Not ready: fix the FAIL items above.");
	return lines.join("\n");
}

/** Runs doctor and returns the process exit code (0 ready, 2 a required check failed). */
export function runDoctor(
	opts: { json: boolean },
	deps: DoctorDeps = realDeps,
	write: (s: string) => void = (s) => process.stdout.write(s),
): number {
	const report = collectReport(deps);
	write(`${opts.json ? JSON.stringify(report, null, 2) : formatTable(report)}\n`);
	return report.ok ? 0 : 2;
}

export function registerDoctorCommand(program: Command): void {
	program
		.command("doctor")
		.description("Check whether this machine is ready to record (read-only, never prompts)")
		.option("--json", "print a machine-readable JSON report", false)
		.action((opts: { json: boolean }) => {
			process.exitCode = runDoctor(opts);
		});
}
