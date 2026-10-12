import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CURSOR_HELPER_NAME,
	DEFAULT_BIN_DIR,
	findPackageRoot,
	NativeHelperMissingError,
	POSITION_HELPER_NAME,
	resolveCursorHelperPath,
	resolvePositionHelperPath,
	resolveScreenCaptureKitHelperPath,
	SCREENCAPTUREKIT_HELPER_NAME,
} from "../src/lib/nativeHelpers.js";

describe("nativeHelpers", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "lensmith-native-helpers-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("throws a clear, actionable error when a helper binary is missing", () => {
		expect(() => resolveScreenCaptureKitHelperPath(dir)).toThrow(NativeHelperMissingError);
		try {
			resolveScreenCaptureKitHelperPath(dir);
		} catch (error) {
			expect((error as Error).message).toContain(SCREENCAPTUREKIT_HELPER_NAME);
			expect((error as Error).message).toContain("npm run build:native:mac");
		}
	});

	it("resolves an existing, executable helper binary", () => {
		const binPath = path.join(dir, CURSOR_HELPER_NAME);
		writeFileSync(binPath, "#!/bin/sh\necho fake helper\n");
		chmodSync(binPath, 0o755);
		expect(resolveCursorHelperPath(dir)).toBe(binPath);
	});

	it("throws when the file exists but is not executable", () => {
		const binPath = path.join(dir, CURSOR_HELPER_NAME);
		writeFileSync(binPath, "not executable");
		chmodSync(binPath, 0o644);
		expect(() => resolveCursorHelperPath(dir)).toThrow(NativeHelperMissingError);
	});

	// CR-LENSMITH-A009-2: the npm tarball ships prebuilt helpers in <package root>/bin/, and the
	// package can live anywhere (global prefix, local node_modules, npx cache).
	it("finds the package root and bin/ in a global-install layout", () => {
		const pkgRoot = path.join(dir, "prefix", "lib", "node_modules", "lensmith");
		const distLib = path.join(pkgRoot, "dist", "lib");
		mkdirSync(distLib, { recursive: true });
		mkdirSync(path.join(pkgRoot, "bin"));
		writeFileSync(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "lensmith" }));
		// A parent package.json with another name must not stop or redirect the walk.
		writeFileSync(path.join(dir, "prefix", "package.json"), JSON.stringify({ name: "other" }));
		const helper = path.join(pkgRoot, "bin", POSITION_HELPER_NAME);
		writeFileSync(helper, "#!/bin/sh\n");
		chmodSync(helper, 0o755);

		expect(findPackageRoot(distLib)).toBe(pkgRoot);
		expect(resolvePositionHelperPath(path.join(findPackageRoot(distLib), "bin"))).toBe(helper);
	});

	it("finds the package root from a local node_modules install inside another project", () => {
		writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "my-app" }));
		const pkgRoot = path.join(dir, "node_modules", "lensmith");
		const distLib = path.join(pkgRoot, "dist", "lib");
		mkdirSync(distLib, { recursive: true });
		writeFileSync(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "lensmith" }));
		expect(findPackageRoot(distLib)).toBe(pkgRoot);
	});

	it("falls back to two directories up when no lensmith package.json exists", () => {
		const distLib = path.join(dir, "x", "dist", "lib");
		mkdirSync(distLib, { recursive: true });
		expect(findPackageRoot(distLib)).toBe(path.join(dir, "x"));
	});

	it("defaults to this repo's own bin/ directory", () => {
		expect(DEFAULT_BIN_DIR).toBe(
			path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin"),
		);
	});
});
