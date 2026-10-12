import type { Readable } from "node:stream";

/**
 * Reads newline-delimited JSON from a child process stream and invokes
 * `onLine` with each parsed object. All three native helpers (the two
 * vendored OpenScreen executables and Lensmith's own position poller)
 * speak this exact protocol (see their `emit()`/`print()` calls).
 * Malformed lines are dropped rather than thrown — a single corrupt line
 * from a helper must never crash the CLI mid-recording.
 */
export function readNdjson(stream: Readable, onLine: (value: unknown) => void): void {
	let buffer = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		buffer += chunk;
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}
			try {
				onLine(JSON.parse(trimmed));
			} catch {
				// Ignore non-JSON/partial output rather than crash the recording.
			}
		}
	});
}
