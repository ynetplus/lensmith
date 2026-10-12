import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Compiled output lives at dist/lib/nativeHelpers.js — repo root is two
// directories up. `bin/` is gitignored (build artifact, see
// `npm run build:native:mac`); CI builds it fresh every run.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const binDir = path.join(repoRoot, "bin");

export const SCREENCAPTUREKIT_HELPER_NAME = "openscreen-screencapturekit-helper";
export const CURSOR_HELPER_NAME = "openscreen-macos-cursor-helper";
export const POSITION_HELPER_NAME = "lensmith-cursor-position-helper";

export class NativeHelperMissingError extends Error {}

function resolveBinPath(name: string, baseDir: string): string {
	const binPath = path.join(baseDir, name);
	try {
		accessSync(binPath, fsConstants.X_OK);
	} catch {
		throw new NativeHelperMissingError(
			`Native helper "${name}" not found or not executable at ${binPath}. ` +
				'Run "npm run build:native:mac" first (requires Xcode / a full Swift toolchain).',
		);
	}
	return binPath;
}

// `baseDir` is injectable (tests only) — production callers always resolve against the repo's
// real `bin/` directory via the default.
export function resolveScreenCaptureKitHelperPath(baseDir: string = binDir): string {
	return resolveBinPath(SCREENCAPTUREKIT_HELPER_NAME, baseDir);
}

export function resolveCursorHelperPath(baseDir: string = binDir): string {
	return resolveBinPath(CURSOR_HELPER_NAME, baseDir);
}

export function resolvePositionHelperPath(baseDir: string = binDir): string {
	return resolveBinPath(POSITION_HELPER_NAME, baseDir);
}
