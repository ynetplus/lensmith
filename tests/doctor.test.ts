import { describe, expect, it } from "vitest";
import { collectReport, type DoctorDeps, formatTable, runDoctor } from "../src/commands/doctor.js";

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
	return {
		platform: "darwin",
		version: () => "9.9.9",
		assertHelpersBuilt: () => undefined,
		readScreenState: () => ({ permission: true, locked: false }),
		hasCommand: () => true,
		chromiumPath: () => "/fake/chromium",
		fileExists: () => true,
		...over,
	};
}

function run(d: DoctorDeps, json = true) {
	let out = "";
	const code = runDoctor({ json }, d, (s) => {
		out += s;
	});
	return { code, out };
}

describe("lensmith doctor", () => {
	it("all checks ok: exit 0, ok:true, valid JSON with 7 checks", () => {
		const { code, out } = run(deps());
		const report = JSON.parse(out);
		expect(code).toBe(0);
		expect(report.ok).toBe(true);
		expect(report.version).toBe("9.9.9");
		expect(report.checks).toHaveLength(7);
		expect(report.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
	});

	it("a required failure: exit 2, ok:false, stable code and fix hint", () => {
		const { code, out } = run(deps({ hasCommand: (c) => c !== "ffmpeg" }));
		const report = JSON.parse(out);
		const ffmpeg = report.checks.find((c: { id: string }) => c.id === "ffmpeg_present");
		expect(code).toBe(2);
		expect(report.ok).toBe(false);
		expect(ffmpeg).toMatchObject({ required: true, ok: false, code: "ffmpeg_missing" });
		expect(ffmpeg.fix).toContain("brew install ffmpeg");
	});

	it("permission denied and locked screen report their own codes", () => {
		const denied = collectReport(
			deps({ readScreenState: () => ({ permission: false, locked: true }) }),
		);
		const byId = Object.fromEntries(denied.checks.map((c) => [c.id, c.code]));
		expect(byId.screen_recording_permission).toBe("screen_recording_denied");
		expect(byId.screen_unlocked).toBe("screen_locked");
		expect(denied.ok).toBe(false);
	});

	it("optional failure (whisperx) never fails the run", () => {
		const { code, out } = run(deps({ hasCommand: (c) => c !== "whisperx" }));
		const report = JSON.parse(out);
		const wx = report.checks.find((c: { id: string }) => c.id === "whisperx_present");
		expect(code).toBe(0);
		expect(report.ok).toBe(true);
		expect(wx).toMatchObject({ required: false, ok: false, code: "whisperx_missing" });
	});

	it("a throwing probe becomes check_error and does not crash", () => {
		const { code, out } = run(
			deps({
				chromiumPath: () => {
					throw new Error("boom");
				},
				readScreenState: () => {
					throw new Error("osascript gone");
				},
			}),
		);
		const report = JSON.parse(out);
		const byId = Object.fromEntries(report.checks.map((c: { id: string }) => [c.id, c]));
		expect(code).toBe(2);
		expect(byId.chromium_for_render.code).toBe("check_error");
		expect(byId.chromium_for_render.detail).toContain("boom");
		expect(byId.screen_recording_permission.code).toBe("check_error");
		expect(byId.screen_unlocked.code).toBe("check_error");
	});

	it("missing native helpers and missing chromium are reported", () => {
		const report = collectReport(
			deps({
				assertHelpersBuilt: () => {
					throw new Error("Native helper missing");
				},
				fileExists: () => false,
			}),
		);
		const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.code]));
		expect(byId.native_helpers_built).toBe("native_helpers_missing");
		expect(byId.chromium_for_render).toBe("chromium_missing");
	});

	it("non-macOS fails platform and never calls the screen probe", () => {
		let called = false;
		const report = collectReport(
			deps({
				platform: "linux",
				readScreenState: () => {
					called = true;
					return { permission: true, locked: false };
				},
			}),
		);
		expect(called).toBe(false);
		expect(report.ok).toBe(false);
		expect(report.checks[0]).toMatchObject({ id: "platform_macos", code: "not_macos" });
	});

	it("human table lists every check and the verdict", () => {
		const text = formatTable(collectReport(deps({ hasCommand: () => false })));
		expect(text).toContain("ffmpeg_missing");
		expect(text).toContain("Not ready");
	});
});
