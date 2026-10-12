#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerCaptionCommand } from "./commands/caption.js";
import { registerComposeCommand } from "./commands/compose.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerGifCommand } from "./commands/gif.js";
import { registerNarrateCommand } from "./commands/narrate.js";
import { registerPackageCommand } from "./commands/package.js";
import { registerProcessCommand } from "./commands/process.js";
import { registerRecordCommand } from "./commands/record.js";
import { registerSuggestZoomsCommand } from "./commands/suggestZooms.js";
import { registerVoiceoverCommand } from "./commands/voiceover.js";

// Keep in sync with package.json "version" — genesis scaffold has no
// runtime package.json read to avoid ESM JSON-import version skew across
// Node releases.
export const LENSMITH_VERSION = "0.1.0";

export function buildProgram(): Command {
	const program = new Command();

	program
		.name("lensmith")
		.description(
			"Lensmith — scriptable screen-recording + auto-zoom for demo/tutorial video, built for AI agents.",
		)
		.version(LENSMITH_VERSION, "-v, --version", "output the current version");

	registerRecordCommand(program);
	registerSuggestZoomsCommand(program);
	registerComposeCommand(program);
	registerProcessCommand(program);
	registerCaptionCommand(program);
	registerNarrateCommand(program);
	registerVoiceoverCommand(program);
	registerGifCommand(program);
	registerPackageCommand(program);
	registerDoctorCommand(program);

	return program;
}

// Compare real paths: an npm install runs the CLI through a bin symlink
// (`<prefix>/bin/lensmith` -> `.../lensmith/dist/cli.js`), so argv[1] is the
// symlink while import.meta.url is the resolved file (CR-LENSMITH-A009-2).
function isInvokedDirectly(): boolean {
	const invoked = process.argv[1];
	if (!invoked) return false;
	try {
		return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

const isMainModule = isInvokedDirectly();

if (isMainModule) {
	buildProgram().parse(process.argv);
}
