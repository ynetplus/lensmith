import { describe, expect, it } from "vitest";
import { buildLaunchOptions, classifyRenderer, rendererLine } from "../src/lib/harnessRunner.js";

describe("buildLaunchOptions", () => {
	it("adds GPU args on darwin by default", () => {
		const o = buildLaunchOptions("darwin", {});
		expect(o.headless).toBe(true);
		expect(o.args).toEqual(["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"]);
	});
	it("adds no args when LENSMITH_RENDER_GPU=0", () => {
		expect(buildLaunchOptions("darwin", { LENSMITH_RENDER_GPU: "0" })).toEqual({ headless: true });
	});
	it("adds no args on non-darwin", () => {
		expect(buildLaunchOptions("linux", {})).toEqual({ headless: true });
		expect(buildLaunchOptions("win32", {})).toEqual({ headless: true });
	});
});

describe("classifyRenderer", () => {
	it("recognises Metal and SwiftShader", () => {
		expect(
			classifyRenderer("ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)"),
		).toBe("gpu");
		expect(
			classifyRenderer("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)"),
		).toBe("software");
		expect(classifyRenderer(null)).toBe("unknown");
	});
	it("builds the stderr line", () => {
		expect(rendererLine("ANGLE Metal")).toBe("lensmith: render GPU: ANGLE Metal");
		expect(rendererLine("SwiftShader")).toBe(
			"lensmith: render GPU unavailable, using software rendering (slower)",
		);
		expect(rendererLine(undefined)).toBeNull();
	});
});
