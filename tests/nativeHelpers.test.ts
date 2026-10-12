import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CURSOR_HELPER_NAME,
	NativeHelperMissingError,
	resolveCursorHelperPath,
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
});
