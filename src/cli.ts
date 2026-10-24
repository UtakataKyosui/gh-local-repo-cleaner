#!/usr/bin/env bun
import { runCli } from "./commands/application.ts";
import { applicationLive } from "./commands/live.ts";

const controller = new AbortController();
const cancel = () => controller.abort();
process.on("SIGINT", cancel);
try {
	process.exitCode = await runCli(
		process.argv.slice(2),
		{
			stdout: (text) => console.log(text),
			stderr: (text) => console.error(text),
			color:
				!process.env.NO_COLOR &&
				(Boolean(process.env.FORCE_COLOR) || Boolean(process.stdout.isTTY)),
		},
		applicationLive(),
		controller.signal,
	);
} finally {
	process.off("SIGINT", cancel);
}
