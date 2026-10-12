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
// bin/ layout. There's no per-arch bin/darwin-<arch> split to maintain.
//
// Two modes (CR-LENSMITH-A009-2):
//   node scripts/build-native-mac.mjs              host arch only (contributors, CI tests)
//   node scripts/build-native-mac.mjs --universal  arm64 + x86_64, merged with `lipo`
//                                                  into one universal binary per helper.
//                                                  This is what the npm tarball ships, so
//                                                  a user's machine never compiles Swift.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const binDir = path.join(root, "bin");
const universal = process.argv.includes("--universal");
const UNIVERSAL_ARCHS = ["arm64", "x86_64"];

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
			// --universal per-arch scratch dirs live under .build/ too; a host-only build
			// must never pick up one of their single-arch slices.
			if (current === dir && entry.name.startsWith("universal-")) continue;
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

function run(command, args, label) {
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
	if (result.error) {
		console.error(`Failed to start ${command} for ${label}: ${result.error.message}`);
		process.exit(1);
	}
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

function locate(buildDir, executableName, label) {
	const source = findExecutable(buildDir, executableName);
	if (!source) {
		console.error(`swift build for ${label} completed but ${executableName} was not found.`);
		process.exit(1);
	}
	return source;
}

// One `swift build` per arch, each into its own scratch dir, so the arm64 and x86_64
// products can never be confused with each other or with a host-only build.
function buildArch(name, packagePath, arch) {
	const scratchPath = path.join(packagePath, ".build", `universal-${arch}`);
	console.log(`Building ${name} (${arch})...`);
	run(
		"swift",
		[
			"build",
			"-c",
			"release",
			"--arch",
			arch,
			"--package-path",
			packagePath,
			"--scratch-path",
			scratchPath,
		],
		`${name} (${arch})`,
	);
	return scratchPath;
}

function assertUniversal(file) {
	const result = spawnSync("lipo", ["-archs", file], { encoding: "utf8" });
	const archs = (result.stdout ?? "").trim().split(/\s+/);
	const missing = UNIVERSAL_ARCHS.filter((a) => !archs.includes(a));
	if (result.status !== 0 || missing.length > 0) {
		console.error(
			`${file} is not universal (lipo -archs: "${archs.join(" ")}", missing: ${missing.join(", ")}).`,
		);
		process.exit(1);
	}
}

fs.mkdirSync(binDir, { recursive: true });

for (const { name, packagePath, executables } of packages) {
	if (universal) {
		const scratchDirs = UNIVERSAL_ARCHS.map((arch) => buildArch(name, packagePath, arch));
		for (const executableName of executables) {
			const slices = scratchDirs.map((dir, i) =>
				locate(dir, executableName, `${name} (${UNIVERSAL_ARCHS[i]})`),
			);
			const dest = path.join(binDir, executableName);
			run("lipo", ["-create", "-output", dest, ...slices], `${executableName} (lipo)`);
			fs.chmodSync(dest, 0o755);
			assertUniversal(dest);
			console.log(
				`Built ${executableName} -> bin/${executableName} (universal: ${UNIVERSAL_ARCHS.join(" + ")})`,
			);
		}
		continue;
	}

	console.log(`Building ${name}...`);
	run("swift", ["build", "-c", "release", "--package-path", packagePath], name);

	const buildDir = path.join(packagePath, ".build");
	for (const executableName of executables) {
		const source = locate(buildDir, executableName, name);
		const dest = path.join(binDir, executableName);
		fs.copyFileSync(source, dest);
		fs.chmodSync(dest, 0o755);
		console.log(`Built ${executableName} -> bin/${executableName}`);
	}
}
