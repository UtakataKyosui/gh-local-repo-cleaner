import { lstat } from "node:fs/promises";
import { Crust, defineCommand } from "@crustjs/core";
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

const failureMessages: Record<string, string> = {
	SERVICE_NOT_CONNECTED: "Required application service is unavailable.",
	GHQ_NOT_FOUND: "ghq was not found; install ghq or specify a directory.",
	GHQ_TIMEOUT: "ghq timed out while listing repositories.",
	GHQ_COMMAND_FAILED: "ghq failed while listing repositories.",
	DISCOVERY_FAILED: "Repository enumeration failed.",
	CONFIG_OR_TARGET_ERROR: "Invalid configuration or target.",
};

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
									message:
										error.detail ??
										failureMessages[error.code] ??
										"Diagnosis failed.",
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
				Effect.map((message) => ({
					message,
					output: "",
					usage: false,
					failed: false,
				})),
				Effect.catch((error) =>
					Effect.succeed({
						message: error.detail ?? error.code,
						output: error.output ?? "",
						usage: error.code === "CONFIG_OR_TARGET_ERROR",
						failed: true,
					}),
				),
			);
			if (result.failed) {
				code = result.usage ? 2 : 1;
				if (result.output) io.stdout(result.output);
				io.stderr(result.message);
			} else io.stdout(result.message);
		}
	});
	const app = new Crust("gh-local-repo-cleaner", {
		description: "Inspect and preserve local Git repositories",
		version: pkg.version,
	})
		.add(
			defineCommand(
				"scan",
				{ description: "Diagnose repositories (read-only)" },
				(command) =>
					command
						.provide(appContext())
						.args({
							name: "directory",
							type: "string",
							description:
								"Directory whose direct children are scanned (default: all ghq repositories)",
						})
						.flags(
							{ name: "json", type: "boolean", description: "Output as JSON" },
							{
								name: "ghq",
								type: "boolean",
								description: "Scan all repositories listed by ghq",
							},
							{
								name: "config",
								type: "string",
								description: "Path to a config file replacing the default",
							},
						)
						.action(handler(() => program)),
			),
		)
		.add(
			defineCommand(
				"list",
				{ description: "List diagnosed repositories (read-only)" },
				(command) =>
					command
						.provide(appContext())
						.args({
							name: "directory",
							type: "string",
							description:
								"Directory whose direct children are listed (default: all ghq repositories)",
						})
						.flags(
							{ name: "json", type: "boolean", description: "Output as JSON" },
							{
								name: "ghq",
								type: "boolean",
								description: "List all repositories listed by ghq",
							},
							{
								name: "config",
								type: "string",
								description: "Path to a config file replacing the default",
							},
							{
								name: "status",
								type: "string",
								description: "Show only repositories with this status",
							},
						)
						.action(handler(() => program)),
			),
		)
		.add(
			defineCommand(
				"inspect",
				{ description: "Show the diagnosis of one repository (read-only)" },
				(command) =>
					command
						.provide(appContext())
						.args({
							name: "target",
							type: "string",
							description:
								"Repository path (absolute, ./ or ../) or ghq name such as github.com/owner/repo",
						})
						.flags(
							{ name: "json", type: "boolean", description: "Output as JSON" },
							{
								name: "config",
								type: "string",
								description: "Path to a config file replacing the default",
							},
						)
						.action(handler(() => program)),
			),
		)
		.add(
			defineCommand(
				"clean",
				{
					description:
						"Move SAFE repositories to the trash so they can be restored",
				},
				(command) =>
					command
						.provide(appContext())
						.args({
							name: "directory",
							type: "string",
							description:
								"Directory whose direct children are cleaned (default: all ghq repositories)",
						})
						.flags(
							{
								name: "yes",
								type: "boolean",
								description: "Move without asking for confirmation",
							},
							{
								name: "dry-run",
								type: "boolean",
								description:
									"Show what would be moved without changing anything",
							},
							{
								name: "ghq",
								type: "boolean",
								description: "Clean repositories listed by ghq",
							},
							{
								name: "config",
								type: "string",
								description: "Path to a config file replacing the default",
							},
							{
								name: "state-dir",
								type: "string",
								description: "Absolute path of the state directory",
							},
						)
						.action(handler(() => program)),
			),
		)
		.add(
			defineCommand(
				"trash",
				{ description: "Inspect repositories moved by clean" },
				(command) =>
					command.add(
						defineCommand(
							"list",
							{ description: "List trashed repositories and their states" },
							(child) =>
								child
									.provide(appContext())
									.flags({
										name: "state-dir",
										type: "string",
										description: "Absolute path of the state directory",
									})
									.action(handler(() => program)),
						),
					),
			),
		)
		.add(
			defineCommand(
				"restore",
				{ description: "Move a trashed repository back to its original path" },
				(command) =>
					command
						.provide(appContext())
						.args({
							name: "id",
							type: "string",
							description: "Trash entry ID shown by trash list",
						})
						.flags(
							{
								name: "yes",
								type: "boolean",
								description: "Restore without asking for confirmation",
							},
							{
								name: "state-dir",
								type: "string",
								description: "Absolute path of the state directory",
							},
						)
						.action(handler(() => program)),
			),
		)
		.provide(appContext())
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
