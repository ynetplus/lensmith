import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRecord } from "../src/lib/recordSession.js";

// Fake native helper: a real child_process has stdout/stderr Readable streams,
// a stdin Writable, EventEmitter-style error/exit events, and kill()/killed.
// PassThrough streams give us the exact same interface `readNdjson` and
// `recordSession.ts` consume, without spawning any real process — this is
// what lets the merge/orchestration logic be tested on any platform/CI
// runner, independent of whether native binaries are built or macOS
// permissions are granted (see forge-lessons.md: mock-connection tests are
// false-green when they replace the thing under test itself — here the
// thing under test IS the orchestration/merge logic, not the native
// helpers, which were separately verified for real, see the forge report).
class FakeChild extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdin = new PassThrough();
	killed = false;
	exitCode: number | null = null;

	kill(): boolean {
		this.killed = true;
		return true;
	}

	emitLine(payload: unknown): void {
		this.stdout.write(`${JSON.stringify(payload)}\n`);
	}
}

const FAKE_PATHS = {
	positionHelperPath: "/fake/lensmith-cursor-position-helper",
	cursorHelperPath: "/fake/openscreen-macos-cursor-helper",
	sckHelperPath: "/fake/openscreen-screencapturekit-helper",
};

interface Scenario {
	spawnFn: ReturnType<typeof buildSpawn>["spawnFn"];
	getChild: (role: keyof typeof FAKE_PATHS) => FakeChild;
	sckReady: Promise<FakeChild>;
}

function buildSpawn(): { spawnFn: (cmd: string, ...rest: unknown[]) => FakeChild } & {
	children: Partial<Record<keyof typeof FAKE_PATHS, FakeChild>>;
} {
	const children: Partial<Record<keyof typeof FAKE_PATHS, FakeChild>> = {};
	const spawnFn = (cmd: string) => {
		const child = new FakeChild();
		if (cmd === FAKE_PATHS.positionHelperPath) children.positionHelperPath = child;
		else if (cmd === FAKE_PATHS.cursorHelperPath) children.cursorHelperPath = child;
		else if (cmd === FAKE_PATHS.sckHelperPath) children.sckHelperPath = child;
		return child;
	};
	return { spawnFn, children };
}

function buildScenario(): Scenario {
	const { spawnFn: rawSpawn, children } = buildSpawn();
	let resolveSckReady!: (child: FakeChild) => void;
	const sckReady = new Promise<FakeChild>((resolve) => {
		resolveSckReady = resolve;
	});

	const spawnFn = ((cmd: string, args: unknown, opts: unknown) => {
		const child = rawSpawn(cmd, args, opts);

		if (cmd === FAKE_PATHS.positionHelperPath) {
			queueMicrotask(() =>
				child.emitLine({
					type: "ready",
					timestampMs: Date.now(),
					displayId: 1,
					bounds: { x: 0, y: 0, width: 1000, height: 500 },
					pixelWidth: 1000,
					pixelHeight: 500,
				}),
			);
		}

		if (cmd === FAKE_PATHS.cursorHelperPath) {
			queueMicrotask(() =>
				child.emitLine({ type: "ready", timestampMs: Date.now(), accessibilityTrusted: true }),
			);
		}

		if (cmd === FAKE_PATHS.sckHelperPath) {
			child.stdin.on("data", (chunk: Buffer) => {
				if (chunk.toString("utf8").trim() === "stop") {
					child.emitLine({ event: "recording-stopped", screenPath: "/tmp/whatever.mp4" });
				}
			});
			queueMicrotask(() => {
				child.emitLine({ event: "ready", schemaVersion: 1 });
				child.emitLine({
					event: "recording-started",
					timestampMs: Date.now(),
					width: 1000,
					height: 500,
				});
				resolveSckReady(child);
			});
		}

		return child as unknown as ReturnType<typeof rawSpawn>;
		// biome-ignore lint/suspicious/noExplicitAny: FakeChild deliberately duck-types child_process's shape
	}) as any;

	return {
		spawnFn,
		getChild: (role) => {
			const child = children[role];
			if (!child) throw new Error(`${role} was never spawned`);
			return child;
		},
		sckReady,
	};
}

describe("runRecord", () => {
	let dir: string;
	let outPath: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "lensmith-record-session-"));
		outPath = path.join(dir, "test.mp4");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes <out>.cursor.json and <out-base>.session.json on a clean SIGINT stop", async () => {
		const scenario = buildScenario();
		const logs: string[] = [];

		const runPromise = runRecord(
			{ source: "screen", fps: 30, mic: false, systemAudio: false, out: outPath },
			{
				spawnFn: scenario.spawnFn,
				resolvePaths: () => FAKE_PATHS,
				startTimeMs: 1_000,
				stopSignal: "SIGUSR2",
				log: (m) => logs.push(m),
				errorLog: (m) => logs.push(m),
			},
		);

		const sckChild = await scenario.sckReady;
		// Simulate a real cursor sample after the SCK helper is up, so the merge has something
		// to record before the recording is stopped.
		scenario.getChild("positionHelperPath").emitLine({
			type: "sample",
			timestampMs: 1_500,
			x: 500,
			y: 250,
		});
		scenario.getChild("cursorHelperPath").emitLine({
			type: "sample",
			timestampMs: 1_533,
			cursorType: "arrow",
			assetId: "abc",
			asset: {
				id: "abc",
				imageDataUrl: "data:image/png;base64,AAAA",
				width: 56,
				height: 80,
				hotspotX: 10,
				hotspotY: 10,
				scaleFactor: 2,
			},
			leftButtonDown: false,
			leftButtonPressed: false,
			leftButtonReleased: false,
		});

		await Promise.resolve(); // let the merge handlers run
		process.emit("SIGUSR2" as NodeJS.Signals, "SIGUSR2" as NodeJS.Signals);

		const exitCode = await runPromise;
		expect(exitCode).toBe(0);
		expect(sckChild.stdin.readableEnded).toBe(false); // we wrote to it, didn't close it

		const cursorJson = JSON.parse(readFileSync(`${outPath}.cursor.json`, "utf8"));
		expect(cursorJson).toMatchObject({ version: 2, provider: "native" });
		expect(cursorJson.samples).toHaveLength(1);
		expect(cursorJson.samples[0]).toMatchObject({ timeMs: 533, cx: 0.5, cy: 0.5 });
		expect(cursorJson.assets).toHaveLength(1);
		expect(cursorJson.assets[0]).toMatchObject({
			id: "abc",
			platform: "darwin",
			width: 56,
			height: 80,
		});

		const sessionJson = JSON.parse(readFileSync(path.join(dir, "test.session.json"), "utf8"));
		expect(sessionJson).toEqual({
			screenVideoPath: outPath,
			createdAt: 1_000,
			cursorCaptureMode: "editable-overlay",
		});

		expect(scenario.getChild("positionHelperPath").killed).toBe(true);
		expect(scenario.getChild("cursorHelperPath").killed).toBe(true);
	});

	it("does not print a success line when the helper reports a failed finalize before closing (BF-6 round 2)", async () => {
		// Round 1 made the SCK helper trap SIGINT so the clean-stop path always runs, but the
		// helper still called exit(0) unconditionally regardless of whether AVAssetWriter actually
		// reached `.completed` — so a failed finalize (writer status `.failed`/incomplete) still
		// reported a clean exit, and round 1's Node-side "clean exit == success" trust turned that
		// into a false "Wrote <file>" success line over an unplayable mp4. The real fix on both
		// sides: the helper now only exits 0 after `finishWriter` confirms `.completed`, and Node
		// no longer infers success from the exit code at all — only from having actually read a
		// definitive NDJSON event.
		const { spawnFn: rawSpawn } = buildSpawn();
		const logs: string[] = [];

		const spawnFn = ((cmd: string, args: unknown, opts: unknown) => {
			const child = rawSpawn(cmd, args, opts);
			if (cmd === FAKE_PATHS.positionHelperPath) {
				queueMicrotask(() =>
					child.emitLine({
						type: "ready",
						displayId: 1,
						bounds: { x: 0, y: 0, width: 1000, height: 500 },
						pixelWidth: 1000,
						pixelHeight: 500,
					}),
				);
			}
			if (cmd === FAKE_PATHS.cursorHelperPath) {
				queueMicrotask(() => child.emitLine({ type: "ready", accessibilityTrusted: true }));
			}
			if (cmd === FAKE_PATHS.sckHelperPath) {
				child.stdin.on("data", (chunk: Buffer) => {
					if (chunk.toString("utf8").trim() === "stop") {
						// A writer that never reached `.completed` — the helper reports it, then
						// exits non-zero (the fixed behavior; a pre-fix helper would exit 0 here).
						child.emitLine({
							event: "error",
							code: "writer-failed",
							message: "AVAssetWriter failed with status 2 (failed).",
						});
						queueMicrotask(() => child.emit("close", 1, null));
					}
				});
				queueMicrotask(() => {
					child.emitLine({ event: "ready", schemaVersion: 1 });
					child.emitLine({
						event: "recording-started",
						timestampMs: Date.now(),
						width: 1000,
						height: 500,
					});
				});
			}
			return child as unknown as ReturnType<typeof rawSpawn>;
			// biome-ignore lint/suspicious/noExplicitAny: see buildScenario
		}) as any;

		const runPromise = runRecord(
			{ source: "screen", fps: 30, mic: false, systemAudio: false, out: outPath },
			{
				spawnFn,
				resolvePaths: () => FAKE_PATHS,
				startTimeMs: 1_000,
				stopSignal: "SIGUSR2",
				log: (m) => logs.push(m),
				errorLog: (m) => logs.push(m),
			},
		);

		await new Promise((resolve) => setImmediate(resolve));
		process.emit("SIGUSR2" as NodeJS.Signals, "SIGUSR2" as NodeJS.Signals);

		const exitCode = await runPromise;
		expect(exitCode).toBe(1);
		expect(logs.some((line) => line.includes("AVAssetWriter failed"))).toBe(true);
		expect(logs.some((line) => line.includes("Wrote"))).toBe(false);
		expect(logs.some((line) => line.includes("Recording stopped."))).toBe(false);
		expect(() => readFileSync(`${outPath}.cursor.json`, "utf8")).toThrow();
	});

	it("does not print a success line when the helper closes without ever confirming completion (BF-6 round 2)", async () => {
		// The false-success bug this closes is exactly: a helper that closes cleanly (code 0) after
		// a stop was requested, but never actually emitted "recording-stopped" — e.g. the pre-fix
		// unconditional exit(0), or any crash/early-exit that skips the confirmation event. Round 1
		// treated a bare `code === 0 && signal === null` as sufficient; that is the bug, not a fix.
		const { spawnFn: rawSpawn } = buildSpawn();
		const logs: string[] = [];

		const spawnFn = ((cmd: string, args: unknown, opts: unknown) => {
			const child = rawSpawn(cmd, args, opts);
			if (cmd === FAKE_PATHS.positionHelperPath) {
				queueMicrotask(() =>
					child.emitLine({
						type: "ready",
						displayId: 1,
						bounds: { x: 0, y: 0, width: 1000, height: 500 },
						pixelWidth: 1000,
						pixelHeight: 500,
					}),
				);
			}
			if (cmd === FAKE_PATHS.cursorHelperPath) {
				queueMicrotask(() => child.emitLine({ type: "ready", accessibilityTrusted: true }));
			}
			if (cmd === FAKE_PATHS.sckHelperPath) {
				child.stdin.on("data", (chunk: Buffer) => {
					if (chunk.toString("utf8").trim() === "stop") {
						// Deliberately never emit "recording-stopped" or "error" — only a clean
						// close (code 0, no signal), reproducing the exact shape that used to be
						// trusted as success.
						child.emit("close", 0, null);
					}
				});
				queueMicrotask(() => {
					child.emitLine({ event: "ready", schemaVersion: 1 });
					child.emitLine({
						event: "recording-started",
						timestampMs: Date.now(),
						width: 1000,
						height: 500,
					});
				});
			}
			return child as unknown as ReturnType<typeof rawSpawn>;
			// biome-ignore lint/suspicious/noExplicitAny: see buildScenario
		}) as any;

		const runPromise = runRecord(
			{ source: "screen", fps: 30, mic: false, systemAudio: false, out: outPath },
			{
				spawnFn,
				resolvePaths: () => FAKE_PATHS,
				startTimeMs: 1_000,
				stopSignal: "SIGUSR2",
				log: (m) => logs.push(m),
				errorLog: (m) => logs.push(m),
			},
		);

		await new Promise((resolve) => setImmediate(resolve));
		process.emit("SIGUSR2" as NodeJS.Signals, "SIGUSR2" as NodeJS.Signals);

		const exitCode = await runPromise;
		expect(exitCode).toBe(1);
		expect(logs.some((line) => line.includes("exited unexpectedly"))).toBe(true);
		expect(logs.some((line) => line.includes("Wrote"))).toBe(false);
		expect(logs.some((line) => line.includes("Recording stopped."))).toBe(false);
		expect(() => readFileSync(`${outPath}.cursor.json`, "utf8")).toThrow();
	});

	it("prints the one-time accessibility message when the cursor helper reports it untrusted", async () => {
		const { spawnFn: rawSpawn, children } = buildSpawn();
		const logs: string[] = [];
		let resolveSckReady!: (child: FakeChild) => void;
		const sckReady = new Promise<FakeChild>((resolve) => {
			resolveSckReady = resolve;
		});

		const spawnFn = ((cmd: string, args: unknown, opts: unknown) => {
			const child = rawSpawn(cmd, args, opts);
			if (cmd === FAKE_PATHS.positionHelperPath) {
				queueMicrotask(() =>
					child.emitLine({
						type: "ready",
						displayId: 1,
						bounds: { x: 0, y: 0, width: 1000, height: 500 },
						pixelWidth: 1000,
						pixelHeight: 500,
					}),
				);
			}
			if (cmd === FAKE_PATHS.cursorHelperPath) {
				queueMicrotask(() =>
					child.emitLine({ type: "ready", accessibilityTrusted: false, mouseTapReady: true }),
				);
			}
			if (cmd === FAKE_PATHS.sckHelperPath) {
				child.stdin.on("data", (chunk: Buffer) => {
					if (chunk.toString("utf8").trim() === "stop") {
						child.emitLine({ event: "recording-stopped", screenPath: outPath });
					}
				});
				queueMicrotask(() => {
					child.emitLine({ event: "ready" });
					resolveSckReady(child);
				});
			}
			return child as unknown as ReturnType<typeof rawSpawn>;
			// biome-ignore lint/suspicious/noExplicitAny: see buildScenario
		}) as any;

		const runPromise = runRecord(
			{ source: "screen", fps: 30, mic: false, systemAudio: false, out: outPath },
			{
				spawnFn,
				resolvePaths: () => FAKE_PATHS,
				startTimeMs: 1_000,
				stopSignal: "SIGUSR2",
				log: (m) => logs.push(m),
				errorLog: (m) => logs.push(m),
			},
		);

		await sckReady;
		process.emit("SIGUSR2" as NodeJS.Signals, "SIGUSR2" as NodeJS.Signals);
		await runPromise;

		expect(logs.some((line) => line.includes("Accessibility permission is not yet granted"))).toBe(
			true,
		);
		void children;
	});

	it("exits 1 and does not write sidecar files when the ScreenCaptureKit helper reports an error", async () => {
		const { spawnFn: rawSpawn } = buildSpawn();
		const logs: string[] = [];

		const spawnFn = ((cmd: string, args: unknown, opts: unknown) => {
			const child = rawSpawn(cmd, args, opts);
			if (cmd === FAKE_PATHS.positionHelperPath) {
				queueMicrotask(() =>
					child.emitLine({
						type: "ready",
						displayId: 1,
						bounds: { x: 0, y: 0, width: 1000, height: 500 },
						pixelWidth: 1000,
						pixelHeight: 500,
					}),
				);
			}
			if (cmd === FAKE_PATHS.cursorHelperPath) {
				queueMicrotask(() => child.emitLine({ type: "ready", accessibilityTrusted: true }));
			}
			if (cmd === FAKE_PATHS.sckHelperPath) {
				queueMicrotask(() =>
					child.emitLine({
						event: "error",
						code: "helper-error",
						message: "No ScreenCaptureKit window found for id 999999.",
					}),
				);
			}
			return child as unknown as ReturnType<typeof rawSpawn>;
			// biome-ignore lint/suspicious/noExplicitAny: see buildScenario
		}) as any;

		const exitCode = await runRecord(
			{ source: "window:999999", fps: 30, mic: false, systemAudio: false, out: outPath },
			{
				spawnFn,
				resolvePaths: () => FAKE_PATHS,
				startTimeMs: 1_000,
				stopSignal: "SIGUSR2",
				log: (m) => logs.push(m),
				errorLog: (m) => logs.push(m),
			},
		);

		expect(exitCode).toBe(1);
		expect(logs.some((line) => line.includes("No ScreenCaptureKit window found"))).toBe(true);
		expect(() => readFileSync(`${outPath}.cursor.json`, "utf8")).toThrow();
	});

	it("rejects an invalid --source before spawning the recording helper", async () => {
		const { spawnFn: rawSpawn } = buildSpawn();
		const logs: string[] = [];

		const spawnFn = ((cmd: string, args: unknown, opts: unknown) => {
			const child = rawSpawn(cmd, args, opts);
			if (cmd === FAKE_PATHS.positionHelperPath) {
				// Source validation happens after the position helper reports ready (its `ready`
				// event is what supplies the main display id `parseSourceFlag` needs) — the sck
				// helper is deliberately never scripted to respond here, proving it's never spawned.
				queueMicrotask(() =>
					child.emitLine({
						type: "ready",
						displayId: 1,
						bounds: { x: 0, y: 0, width: 1000, height: 500 },
						pixelWidth: 1000,
						pixelHeight: 500,
					}),
				);
			}
			return child as unknown as ReturnType<typeof rawSpawn>;
			// biome-ignore lint/suspicious/noExplicitAny: see buildScenario
		}) as any;

		const exitCode = await runRecord(
			{ source: "window:not-a-number", fps: 30, mic: false, systemAudio: false, out: outPath },
			{
				spawnFn,
				resolvePaths: () => FAKE_PATHS,
				errorLog: (m) => logs.push(m),
			},
		);

		expect(exitCode).toBe(1);
		expect(logs.some((line) => line.includes('Invalid --source "window:not-a-number"'))).toBe(true);
	});
});
