import { describe, expect, it } from "vitest";
import { deriveCursorJsonPath, deriveSessionJsonPath } from "../src/lib/recordPaths.js";

describe("deriveCursorJsonPath", () => {
	it("appends .cursor.json to the full output path", () => {
		expect(deriveCursorJsonPath("/tmp/test.mp4")).toBe("/tmp/test.mp4.cursor.json");
	});
});

describe("deriveSessionJsonPath", () => {
	it("swaps the extension for .session.json (Acceptance Metric #1: test.mp4 -> test.session.json)", () => {
		expect(deriveSessionJsonPath("/tmp/test.mp4")).toBe("/tmp/test.session.json");
	});

	it("appends .session.json when the output path has no extension", () => {
		expect(deriveSessionJsonPath("/tmp/test")).toBe("/tmp/test.session.json");
	});
});
