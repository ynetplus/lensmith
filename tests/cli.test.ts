import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// These tests exercise the BUILT CLI (`dist/cli.js`), not the TypeScript
// source directly — `npm run build` must run before `npm test` (see the
// Acceptance Metric in CR-LENSMITH-A001-1 and the `test` script's own
// pre-req documented in README.md / CI). This is the same "code on disk is
// not code running" discipline forge applies to E2E verification: we want
// to prove the artifact an operator actually runs, not the source.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, "..", "dist", "cli.js");

function runCli(args: string[]) {
	return spawnSync("node", [CLI_PATH, ...args], { encoding: "utf-8" });
}

describe("lensmith CLI", () => {
	it("--version exits 0 and prints a version string", () => {
		const result = runCli(["--version"]);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("--help exits 0 and lists all 7 subcommands", () => {
		const result = runCli(["--help"]);
		expect(result.status).toBe(0);
		for (const subcommand of [
			"record",
			"suggest-zooms",
			"compose",
			"process",
			"caption",
			"gif",
			"package",
		]) {
			expect(result.stdout).toContain(subcommand);
		}
	});

	it("no arguments prints usage to stderr and exits non-zero (commander default, not a crash)", () => {
		const result = runCli([]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Usage: lensmith");
	});

	// `record` is real as of CR-LENSMITH-A001-2, `suggest-zooms` is real as of
	// CR-LENSMITH-A001-3, and `caption` is real as of CR-LENSMITH-A001-5 — none of the
	// three is a stub anymore, so all three are excluded from the table below. Their own
	// CLI-level coverage lives in tests/suggestZooms.test.ts / tests/caption.test.ts
	// (behavioral) and in the describe blocks below (--help / required-option / real
	// fixture runs, at the built-CLI level).
	// All 6 subcommands are real implementations: process/gif landed in
	// CR-LENSMITH-A001-4 alongside record/suggest-zooms/caption from the
	// earlier CRs, and `compose` in CR-LENSMITH-A001-8 (its own coverage
	// lives in tests/compose.test.ts) — the stub table is intentionally
	// empty; nothing left prints "not yet implemented".
	describe.each([] as [string, string][])("stub subcommand %s", (subcommand, expectedCrRef) => {
		it(`prints its "not yet implemented" message and exits 0`, () => {
			const result = runCli([subcommand]);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("not yet implemented");
			expect(result.stdout).toContain(expectedCrRef);
		});
	});
	// `record` is implemented for real as of CR-LENSMITH-A001-2 — see
	// tests/recordSession.test.ts for the orchestration/merge logic (mocked
	// native helpers, platform-independent) and the CR-LENSMITH-A001-2
	// forge report for the real on-machine E2E recording evidence (a
	// genuine capture can't run unattended in this suite: it needs macOS
	// Screen Recording permission, which can't be granted headlessly).
	describe("record", () => {
		it("--help exits 0 and documents every flag from the Technical Spec", () => {
			const result = runCli(["record", "--help"]);
			expect(result.status).toBe(0);
			for (const flag of ["--source", "--fps", "--mic", "--system-audio", "--out"]) {
				expect(result.stdout).toContain(flag);
			}
		});

		it("rejects a malformed --source before touching any native helper (clear error, not a crash)", () => {
			const result = runCli(["record", "--source", "bogus", "--out", "/tmp/lensmith-cli-test.mp4"]);
			expect(result.status).not.toBe(0);
			expect(result.stdout + result.stderr).toContain('Invalid --source "bogus"');
		});

		it("rejects a non-integer --fps (commander-level validation)", () => {
			const result = runCli(["record", "--fps", "not-a-number"]);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("--fps must be a positive integer");
		});
	});

	// `process` / `gif` are implemented (CR-LENSMITH-A001-4) — real render
	// pipeline, not a stub. Full E2E render coverage (real fixture, real
	// headless-Chromium harness) lives in tests/render.test.ts; here we only
	// check the CLI surface (required-option validation), which is fast.
	describe.each([["process"], ["gif"]])("implemented subcommand %s", (subcommand) => {
		it("fails fast with a usage error when required options are missing (not a crash)", () => {
			const result = runCli([subcommand]);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("required option");
		});
	});

	// `package` is real as of CR-LENSMITH-A001-11 (role 10, the export-profile
	// packager). Real fixture/ffmpeg coverage lives in tests/package.test.ts;
	// here we only check the CLI surface (required-option validation), which
	// is fast and doesn't need ffmpeg on PATH.
	describe("package subcommand (CLI surface)", () => {
		it("requires --in, --out-dir and --profile — missing all fails non-zero with a usage error", () => {
			const result = runCli(["package"]);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("required option");
		});

		it("requires --profile when --in and --out-dir are given", () => {
			const result = runCli([
				"package",
				"--in",
				"/tmp/does-not-matter.mp4",
				"--out-dir",
				"/tmp/does-not-matter-dir",
			]);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("required option");
			expect(result.stderr).toContain("--profile");
		});

		it("a nonexistent --in file fails clearly, not with a crash", () => {
			const result = runCli([
				"package",
				"--in",
				"/tmp/lensmith-test-does-not-exist.mp4",
				"--out-dir",
				"/tmp/lensmith-test-out-dir",
				"--profile",
				"hero",
			]);
			expect(result.status).not.toBe(0);
			expect(result.stdout + result.stderr).toContain("not found");
		});
	});

	it("an unknown subcommand fails with a non-zero exit and usage error (not a crash)", () => {
		const result = runCli(["not-a-real-command"]);
		expect(result.status).not.toBe(0);
		expect(result.stderr.toLowerCase()).toContain("unknown command");
	});

	describe("suggest-zooms (real, CR-LENSMITH-A001-3)", () => {
		it("suggest-zooms --help documents all flags", () => {
			const result = runCli(["suggest-zooms", "--help"]);
			expect(result.status).toBe(0);
			for (const flag of ["--cursor", "--duration-ms", "--default-duration-ms", "--out"]) {
				expect(result.stdout).toContain(flag);
			}
		});

		it("missing required options fails with a non-zero exit (not a crash, not silent)", () => {
			const result = runCli(["suggest-zooms"]);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("required option");
		});

		describe("end-to-end against the real fixture", () => {
			let tmpDir: string;

			afterEach(() => {
				if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
			});

			it("runs the BUILT CLI against the real cursor.json and writes a valid zooms.json", () => {
				tmpDir = mkdtempSync(path.join(tmpdir(), "lensmith-cli-test-"));
				const outPath = path.join(tmpDir, "zooms.json");
				const cursorPath = path.join(
					__dirname,
					"fixtures",
					"recording-1786461836877.mp4.cursor.json",
				);

				const result = runCli([
					"suggest-zooms",
					"--cursor",
					cursorPath,
					"--duration-ms",
					"60453",
					"--out",
					outPath,
				]);

				expect(result.status).toBe(0);
				expect(result.stdout).toContain("wrote");
				expect(existsSync(outPath)).toBe(true);

				const written = JSON.parse(readFileSync(outPath, "utf-8"));
				expect(Array.isArray(written.zoomRegions)).toBe(true);
				expect(written.zoomRegions.length).toBe(7);
				for (const region of written.zoomRegions) {
					expect(region.source).toBe("auto");
					expect(region.depth).toBe(3);
					expect(typeof region.focus.cx).toBe("number");
					expect(typeof region.focus.cy).toBe("number");
				}
			});

			it("a malformed cursor file fails with a non-zero exit and a clear stderr message", () => {
				tmpDir = mkdtempSync(path.join(tmpdir(), "lensmith-cli-test-"));
				const outPath = path.join(tmpDir, "zooms.json");

				const result = runCli([
					"suggest-zooms",
					"--cursor",
					path.join(tmpDir, "does-not-exist.cursor.json"),
					"--duration-ms",
					"60453",
					"--out",
					outPath,
				]);

				expect(result.status).not.toBe(0);
				expect(result.stderr).toContain("could not read cursor telemetry file");
				expect(existsSync(outPath)).toBe(false);
			});
		});
	});

	// `caption` is now a real implementation (CR-LENSMITH-A001-5) — its
	// behavioral tests live in tests/caption.test.ts. Only CLI-surface
	// argument validation is covered here, at the built-CLI level.
	describe("caption subcommand (CLI surface)", () => {
		it("requires --in and --out — missing both fails non-zero with a usage error", () => {
			const result = runCli(["caption"]);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("required option");
		});

		it("requires --out when --in is given", () => {
			const result = runCli(["caption", "--in", "/tmp/does-not-matter.mp4"]);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("required option");
			expect(result.stderr).toContain("--out");
		});

		it("a nonexistent --in file fails clearly, not with a crash", () => {
			const result = runCli([
				"caption",
				"--in",
				"/tmp/lensmith-test-does-not-exist.mp4",
				"--out",
				"/tmp/lensmith-test-out.mp4",
			]);
			expect(result.status).not.toBe(0);
			expect(result.stdout + result.stderr).toContain("not found");
		});
	});
});
