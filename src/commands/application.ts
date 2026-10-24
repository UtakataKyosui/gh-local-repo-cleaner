import { lstat } from "node:fs/promises";
import { Crust } from "@crustjs/core";
import { handler, layer } from "@crustjs/effect";
import { help, version } from "@crustjs/extensions";
import type { Layer } from "effect";
import { Effect } from "effect";
import pkg from "../../package.json" with { type: "json" };
import {
	type Invocation,
	normalizeArguments,
	UsageError,
} from "./arguments.ts";
import { present } from "./output.ts";
import { Application, ApplicationUnavailable } from "./services.ts";

interface IO {
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
}

export async function runCli(
	argv: readonly string[],
	io: IO,
	application: Layer.Layer<Application> = ApplicationUnavailable,
	signal?: AbortSignal,
): Promise<number> {
	let invocation: Invocation | undefined;
	let code = 0;
	const separator = argv.indexOf("--");
	const options = argv.slice(0, separator < 0 ? argv.length : separator);
	const informational = options.some((arg) =>
		["--help", "-h", "--version", "-v"].includes(arg),
	);
	if (!informational) {
		try {
			invocation = normalizeArguments(argv);
			const first = argv[0];
			if (
				first &&
				!first.startsWith("-") &&
				!first.includes("/") &&
				!["scan", "list", "inspect", "clean", "trash", "restore"].includes(
					first,
				)
			) {
				const directory = await lstat(first).catch(() => null);
				if (!directory?.isDirectory())
					throw new UsageError("Unknown command or directory");
			}
		} catch (error) {
			if (!(error instanceof UsageError)) throw error;
			io.stderr(error.message);
			return 2;
		}
	}
	const appContext = layer("application", application);
	const program = Effect.gen(function* () {
		if (!invocation) return;
		const service = yield* Application;
		if (["scan", "list", "inspect"].includes(invocation.operation)) {
			const batch = yield* service.diagnose(invocation).pipe(
				Effect.catch((error) =>
					Effect.sync(() => {
						if (error.code === "CONFIG_OR_TARGET_ERROR") code = 2;
						return {
							assessments: [],
							errors: [
								{
									code: error.code,
									message: "Required application service is unavailable.",
								},
							],
						};
					}),
				),
			);
			const output = present(batch, invocation);
			io.stdout(output.stdout);
			if (output.stderr) io.stderr(output.stderr);
			code = code || output.exitCode;
		} else {
			const result = yield* service.operate(invocation).pipe(
				Effect.map((message) => ({ message, failed: false })),
				Effect.catch((error) =>
					Effect.succeed({ message: error.code, failed: true }),
				),
			);
			if (result.failed) {
				code = result.message === "CONFIG_OR_TARGET_ERROR" ? 2 : 1;
				io.stderr(result.message);
			} else io.stdout(result.message);
		}
	});
	const app = new Crust("gh-local-repo-cleaner", {
		description: "Inspect and preserve local Git repositories",
		version: pkg.version,
	})
		.provide(appContext())
		.command("scan", (command) =>
			command
				.args({ name: "directory", type: "string" })
				.flags(
					{ name: "json", type: "boolean" },
					{ name: "ghq", type: "boolean" },
					{ name: "config", type: "string" },
				)
				.action(handler(() => program)),
		)
		.command("list", (command) =>
			command
				.args({ name: "directory", type: "string" })
				.flags(
					{ name: "json", type: "boolean" },
					{ name: "ghq", type: "boolean" },
					{ name: "config", type: "string" },
					{ name: "status", type: "string" },
				)
				.action(handler(() => program)),
		)
		.command("inspect", (command) =>
			command
				.args({ name: "target", type: "string" })
				.flags(
					{ name: "json", type: "boolean" },
					{ name: "config", type: "string" },
				)
				.action(handler(() => program)),
		)
		.command("clean", (command) =>
			command
				.args({ name: "directory", type: "string" })
				.flags(
					{ name: "yes", type: "boolean" },
					{ name: "dry-run", type: "boolean" },
					{ name: "ghq", type: "boolean" },
					{ name: "config", type: "string" },
					{ name: "state-dir", type: "string" },
				)
				.action(handler(() => program)),
		)
		.command("trash", (command) =>
			command.command("list", (child) =>
				child
					.flags({ name: "state-dir", type: "string" })
					.action(handler(() => program)),
			),
		)
		.command("restore", (command) =>
			command
				.args({ name: "id", type: "string" })
				.flags(
					{ name: "yes", type: "boolean" },
					{ name: "state-dir", type: "string" },
				)
				.action(handler(() => program)),
		)
		.action(handler(() => program))
		.extend(version(), help());
	const normalized = invocation
		? invocation.operation === "trash"
			? ["trash", "list"]
			: [invocation.operation]
		: [...argv];
	const previousExitCode = process.exitCode;
	try {
		const outcome = await app.execute({ argv: normalized, io, signal });
		return outcome || code;
	} finally {
		process.exitCode = previousExitCode ?? 0;
	}
}
