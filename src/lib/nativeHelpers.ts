import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "lensmith";

/**
 * Finds the Lensmith package root by walking up from `startDir` to the nearest `package.json`
 * whose `name` is "lensmith" (CR-LENSMITH-A009-2). This holds for every layout the module can
 * run from: a clone (`<repo>/dist/lib`, or `<repo>/src/lib` under vitest), a global install
 * (`<prefix>/lib/node_modules/lensmith/dist/lib`), a local install and an npx cache. The
 * prebuilt native helpers ship in `<package root>/bin/`. Falls back to two directories up
 * (the compiled `dist/lib` layout) if no matching package.json is found.
 */
export function findPackageRoot(startDir: string): string {
	let dir = path.resolve(startDir);
	for (;;) {
		try {
			const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8"));
			if (pkg?.name === PACKAGE_NAME) return dir;
		} catch {
			// No (readable) package.json here: keep walking up.
		}
		const parent = path.dirname(dir);
		if (parent === dir) return path.resolve(startDir, "..", "..");
		dir = parent;
	}
}

// `bin/` holds the native helpers: prebuilt universal binaries in the npm tarball, or built
// locally by `npm run build:native:mac` in a clone (gitignored there).
const packageRoot = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_BIN_DIR = path.join(packageRoot, "bin");

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

// `baseDir` is injectable (tests only) — production callers always resolve against the
// package's real `bin/` directory via the default.
export function resolveScreenCaptureKitHelperPath(baseDir: string = DEFAULT_BIN_DIR): string {
	return resolveBinPath(SCREENCAPTUREKIT_HELPER_NAME, baseDir);
}

export function resolveCursorHelperPath(baseDir: string = DEFAULT_BIN_DIR): string {
	return resolveBinPath(CURSOR_HELPER_NAME, baseDir);
}

export function resolvePositionHelperPath(baseDir: string = DEFAULT_BIN_DIR): string {
	return resolveBinPath(POSITION_HELPER_NAME, baseDir);
}
