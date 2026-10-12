#!/usr/bin/env node
// Builds Lensmith's native macOS helpers into bin/ (gitignored — CI and
// operators build it fresh, see README.md "Development"):
//   - the two vendored OpenScreen Swift executables, src/native/screencapturekit/
//     (byte-identical to the pinned upstream commit — see NOTICE.md)
//   - Lensmith's own cursor-position poller, src/native/lensmith-helpers/
//     (original code, not vendored — see that package's Package.swift header)
//
// Shape mirrors OpenScreen's own scripts/build-macos-screencapturekit-helper.mjs
// (read as reference during CR-LENSMITH-A001-2), adapted for Lensmith's flat
// bin/ layout — Lensmith ships as a CLI built on the operator's own machine,
// not a packaged multi-arch Electron app, so there's no per-arch
// bin/darwin-<arch> split to maintain.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const binDir = path.join(root, "bin");

if (process.platform !== "darwin") {
	console.log("Skipping native macOS helper build: host platform is not macOS.");
	process.exit(0);
}

const xcodebuildVersion = spawnSync("xcodebuild", ["-version"], { cwd: root, encoding: "utf8" });
if (xcodebuildVersion.status !== 0) {
	const message = `${xcodebuildVersion.stderr ?? ""}${xcodebuildVersion.stdout ?? ""}`.trim();
	console.error(
		[
			"Unable to build the native macOS helpers because full Xcode is not active.",
			"",
			message,
			"",
			"Install Xcode from the App Store or Apple Developer downloads, then run:",
			"  sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer",
			"  sudo xcodebuild -license accept",
		].join("\n"),
	);
	process.exit(1);
}

const packages = [
	{
		name: "src/native/screencapturekit (vendored, OpenScreen)",
		packagePath: path.join(root, "src", "native", "screencapturekit"),
		executables: ["openscreen-screencapturekit-helper", "openscreen-macos-cursor-helper"],
	},
	{
		name: "src/native/lensmith-helpers (Lensmith's own)",
		packagePath: path.join(root, "src", "native", "lensmith-helpers"),
		executables: ["lensmith-cursor-position-helper"],
	},
];

// SwiftPM writes a single-arch release build to
// <buildDir>/<swiftArch>-apple-macosx/release/<name>. Search rather than
// hardcode the arch dir name (skip .dSYM bundles, which contain a
// same-named but unrunnable file) — matches OpenScreen's own
// `findExecutable()` in scripts/build-macos-screencapturekit-helper.mjs.
function findExecutable(dir, name) {
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop();
		let entries;
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name.endsWith(".dSYM")) continue;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.isFile() && entry.name === name && /[/\\]release[/\\]/i.test(full)) {
				return full;
			}
		}
	}
	return null;
}

fs.mkdirSync(binDir, { recursive: true });

for (const { name, packagePath, executables } of packages) {
	console.log(`Building ${name}...`);
	const result = spawnSync("swift", ["build", "-c", "release", "--package-path", packagePath], {
		cwd: root,
		stdio: "inherit",
	});
	if (result.error) {
		console.error(`Failed to start swift build for ${name}: ${result.error.message}`);
		process.exit(1);
	}
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}

	const buildDir = path.join(packagePath, ".build");
	for (const executableName of executables) {
		const source = findExecutable(buildDir, executableName);
		if (!source) {
			console.error(`swift build for ${name} completed but ${executableName} was not found.`);
			process.exit(1);
		}
		const dest = path.join(binDir, executableName);
		fs.copyFileSync(source, dest);
		fs.chmodSync(dest, 0o755);
		console.log(`Built ${executableName} -> bin/${executableName}`);
	}
}
