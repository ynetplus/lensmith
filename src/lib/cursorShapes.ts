/**
 * CR-LENSMITH-A007-11: films always draw the arrow cursor (pacing LOCK, Drew 2026-10-12).
 * Pure pre-render mapping over the cursor telemetry: under `arrow` every sample is tagged
 * `cursorType: "arrow"`, which the vendored renderer resolves to its arrow asset; under
 * `native` the telemetry is returned untouched. Position, timing and clicks are never edited.
 * Imported by the render harness bootstrap (bundled by esbuild) and by tests.
 */
export type CursorShapes = "arrow" | "native";

export const CURSOR_SHAPES_DEFAULT: CursorShapes = "arrow";

export function parseCursorShapes(value: string): CursorShapes {
	if (value === "arrow" || value === "native") return value;
	throw new Error(`--cursor-shapes must be "arrow" or "native", got "${value}"`);
}

export function applyCursorShapes<T extends { samples: object[] } | null>(
	data: T,
	shapes: CursorShapes,
): T {
	if (!data || shapes === "native") return data;
	return {
		...data,
		samples: data.samples.map((s) => ({ ...s, cursorType: "arrow" })),
	};
}
