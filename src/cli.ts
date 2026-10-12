#!/usr/bin/env node
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

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;

if (isMainModule) {
	buildProgram().parse(process.argv);
}
