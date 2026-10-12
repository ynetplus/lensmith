#!/usr/bin/env node
// Checks what `npm pack` would put in the lensmith tarball (CR-LENSMITH-A009-2), so a
// publish can never ship a package that is missing a runtime file or carries files it must
// not carry. Runs as the last step of `prepublishOnly`, and by hand: `npm run pack:check`.
//
//   node scripts/pack-check.mjs              check the file list, modes, contents and size
//   node scripts/pack-check.mjs --self-test  prove the bin check rejects a stripped/invalid bin
//   node scripts/pack-check.mjs --universal  also require every native helper in bin/ to be a
//                                            universal (arm64 + x86_64) Mach-O binary
//
// It reads the file list from `npm pack --dry-run --json` (the exact list `npm pack` and
// `npm publish` use) and never writes a tarball. Exit 0 = pass, 1 = at least one failure.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const universal = process.argv.includes("--universal");
const selfTest = process.argv.includes("--self-test");

// Size budget. Measured at 0.1.0: 1.86 MB packed, 6.45 MB unpacked, 33 files; the largest
// file is the 3.2 MB web-demuxer wasm, then the 2.1 MB harness bundle. The budget leaves headroom for normal growth but catches an
// accidental fixture, video, node_modules or .build/ folder, which are all far larger.
const MAX_PACKED_BYTES = 6 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 15 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const NATIVE_HELPERS = [
	"openscreen-screencapturekit-helper",
	"openscreen-macos-cursor-helper",
	"lensmith-cursor-position-helper",
];

// Files the installed CLI reads at run time. Every src/commands and src/lib module must
// also have its compiled dist/ counterpart (added below), so a stale or partial build fails.
const REQUIRED = [
	"package.json",
	"README.md",
	"LICENSE",
	"NOTICE.md",
	"dist/cli.js",
	"dist/harness/process.html",
	"dist/harness/process.bundle.js",
	"dist/harness/gif.js/dist/gif.worker.js",
	"dist/harness/wasm/web-demuxer.wasm",
	"scripts/narrate.py",
	...NATIVE_HELPERS.map((name) => `bin/${name}`),
];
for (const dir of ["commands", "lib"]) {
	for (const file of fs.readdirSync(path.join(root, "src", dir))) {
		if (file.endsWith(".ts") && !file.endsWith(".d.ts")) {
			REQUIRED.push(`dist/${dir}/${file.replace(/\.ts$/, ".js")}`);
		}
	}
}

// Path rules: [pattern, reason]. Matched against the package-relative path.
const FORBIDDEN_PATHS = [
	[/(^|\/)tests?\//, "test directory"],
	[/\.(test|spec)\.[cm]?[jt]sx?$/, "test file"],
	[/\.map$/, "source map"],
	[/(^|\/)\.env(\.|$)/, ".env file"],
	[/(^|\/)(keystone|kpm|kkm)(\/|$)/, "keystone-style path"],
	[/^src\//, "TypeScript source (ship dist/ only)"],
	[/^vendor\//, "raw vendored source (the harness bundle already carries it)"],
	[/(^|\/)node_modules\//, "node_modules"],
	[/(^|\/)\.build\//, "SwiftPM build directory"],
	[/(^|\/)\.DS_Store$/, ".DS_Store"],
	[/(^|\/)\.secrets\.baseline$/, "secrets baseline"],
	[/\.(mp4|mov|webm|gif)$/, "video/recording file"],
];

// Content rules for text files: internal workspace references that must never ship.
// Case-sensitive on purpose: macOS home directories are lowercase, while the harness bundle
// legitimately carries a Windows doc example ("C:/Users/User/...").
const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".json", ".html", ".md", ".py", ".txt"]);
const FORBIDDEN_CONTENT = [
	[/keystone/i, "keystone reference"],
	[/\b(kpm|kkm)\/products\//, "keystone-style path"],
	[/\/Users\/[a-z][a-z0-9._-]*\//, "absolute home-directory path"],
	[/~\/Work\//, "workspace path"],
];

function packList() {
	const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: root,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		console.error(result.stderr || result.stdout);
		throw new Error(`npm pack --dry-run failed (exit ${result.status})`);
	}
	const [info] = JSON.parse(result.stdout);
	return info;
}

// BF-20: npm publish drops a bin path that starts with "./" ("script name ... was invalid and
// removed") while `npm pack` keeps it, so the packed manifest must hold the bare form, and it
// must name a file that is in the tarball. Returns a list of problems (empty = fine).
function binProblems(manifest, filePaths) {
	const target = manifest?.bin?.lensmith;
	if (typeof target !== "string" || target === "") {
		return ["packed package.json has no bin.lensmith (npm publish would ship no command)"];
	}
	if (target.startsWith("./")) {
		return [
			`bin.lensmith is "${target}": npm publish strips a leading "./" and drops the command; use "${target.replace(/^(\.\/)+/, "")}"`,
		];
	}
	if (!filePaths.has(target)) return [`bin.lensmith "${target}" is not a file in the tarball`];
	return [];
}

// Packs for real into a temp dir (scripts ignored, nothing published) and reads the manifest
// out of the tarball, i.e. exactly what an install would see.
function packedManifest() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lensmith-packcheck-"));
	try {
		const packed = spawnSync(
			"npm",
			["pack", "--json", "--ignore-scripts", "--pack-destination", dir],
			{ cwd: root, encoding: "utf8" },
		);
		if (packed.status !== 0) throw new Error(`npm pack failed (exit ${packed.status})`);
		const [{ filename }] = JSON.parse(packed.stdout);
		const read = spawnSync("tar", ["-xOf", path.join(dir, filename), "package/package.json"], {
			encoding: "utf8",
		});
		if (read.status !== 0) throw new Error("could not read package/package.json from the tarball");
		return JSON.parse(read.stdout);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

if (selfTest) {
	const present = new Set(["dist/cli.js"]);
	const cases = [
		["bin with leading ./", { bin: { lensmith: "./dist/cli.js" } }, true],
		["bin missing", { name: "lensmith" }, true],
		["bin names a file not in the tarball", { bin: { lensmith: "dist/nope.js" } }, true],
		["bare bin path", { bin: { lensmith: "dist/cli.js" } }, false],
	];
	let bad = 0;
	for (const [label, manifest, shouldFail] of cases) {
		const problems = binProblems(manifest, present);
		const ok = shouldFail ? problems.length > 0 : problems.length === 0;
		console.log(
			`self-test ${ok ? "ok  " : "FAIL"} ${label}${problems[0] ? ` -> ${problems[0]}` : ""}`,
		);
		if (!ok) bad++;
	}
	process.exit(bad === 0 ? 0 : 1);
}

function mb(bytes) {
	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const info = packList();
const files = new Map(info.files.map((f) => [f.path, f]));
const failures = [];

for (const required of REQUIRED) {
	if (!files.has(required)) failures.push(`missing required file: ${required}`);
}
if (![...files.keys()].some((p) => /^dist\/harness\/wallpapers\/.+\.jpe?g$/.test(p))) {
	failures.push("missing required file: dist/harness/wallpapers/*.jpg");
}

failures.push(...binProblems(packedManifest(), new Set(files.keys())));

for (const name of NATIVE_HELPERS) {
	const entry = files.get(`bin/${name}`);
	if (entry && (entry.mode & 0o111) === 0) {
		failures.push(`bin/${name} is not executable in the tarball (mode ${entry.mode.toString(8)})`);
	}
}

for (const [file, entry] of files) {
	for (const [pattern, reason] of FORBIDDEN_PATHS) {
		if (pattern.test(file)) failures.push(`forbidden file (${reason}): ${file}`);
	}
	if (entry.size > MAX_FILE_BYTES) {
		failures.push(
			`file over the ${mb(MAX_FILE_BYTES)} per-file budget: ${file} (${mb(entry.size)})`,
		);
	}
	if (TEXT_EXT.has(path.extname(file))) {
		const text = fs.readFileSync(path.join(root, file), "utf8");
		for (const [pattern, reason] of FORBIDDEN_CONTENT) {
			const match = text.match(pattern);
			if (match) failures.push(`forbidden content (${reason}) in ${file}: "${match[0]}"`);
		}
	}
}

if (info.size > MAX_PACKED_BYTES) {
	failures.push(`tarball ${mb(info.size)} is over the ${mb(MAX_PACKED_BYTES)} packed budget`);
}
if (info.unpackedSize > MAX_UNPACKED_BYTES) {
	failures.push(`unpacked ${mb(info.unpackedSize)} is over the ${mb(MAX_UNPACKED_BYTES)} budget`);
}

if (universal) {
	for (const name of NATIVE_HELPERS) {
		const file = path.join(root, "bin", name);
		if (!fs.existsSync(file)) continue; // already reported as missing
		const result = spawnSync("lipo", ["-archs", file], { encoding: "utf8" });
		const archs = (result.stdout ?? "").trim().split(/\s+/);
		for (const arch of ["arm64", "x86_64"]) {
			if (!archs.includes(arch))
				failures.push(`bin/${name} lacks the ${arch} slice (lipo -archs: "${archs.join(" ")}")`);
		}
	}
}

console.log(
	`pack-check: ${info.filename} — ${info.entryCount} files, ${mb(info.size)} packed, ${mb(info.unpackedSize)} unpacked` +
		` (budget ${mb(MAX_PACKED_BYTES)} / ${mb(MAX_UNPACKED_BYTES)})${universal ? ", universal helpers required" : ""}`,
);
if (failures.length > 0) {
	for (const failure of failures) console.error(`  FAIL ${failure}`);
	console.error(
		`pack-check: FAILED (${failures.length} problem${failures.length === 1 ? "" : "s"})`,
	);
	process.exit(1);
}
console.log(`pack-check: OK (${REQUIRED.length + 1} required entries present, no forbidden files)`);
