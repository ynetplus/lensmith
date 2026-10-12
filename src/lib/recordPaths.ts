import path from "node:path";

/** `<out>.cursor.json` — append-style, matches OpenScreen's own
 *  `${targetVideoPath}.cursor.json` convention verbatim. */
export function deriveCursorJsonPath(outPath: string): string {
	return `${outPath}.cursor.json`;
}

/** `<out-without-extension>.session.json` — extension-SWAP, not append. For
 *  `test.mp4` this is `test.session.json`, not `test.mp4.session.json` —
 *  literal per the CR-LENSMITH-A001-2 Acceptance Metric's own example. */
export function deriveSessionJsonPath(outPath: string): string {
	const ext = path.extname(outPath);
	const base = ext ? outPath.slice(0, -ext.length) : outPath;
	return `${base}.session.json`;
}
