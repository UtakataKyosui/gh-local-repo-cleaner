import { lstat } from "node:fs/promises";
import { Crust, type CrustCommandContext, defineCommand } from "@crustjs/core";
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
import { failureMessage, localizeUsage, peekLocale } from "./messages.ts";
import { present } from "./output.ts";
import { Application, ApplicationUnavailable } from "./services.ts";
import { type CommandSpec, commandTable, flagTable } from "./spec.ts";

type ActionInput = CrustCommandContext<never, never, never>;

// The chain's generic types depend on which args/flags are present, which a spec table cannot express.
interface LooseBuilder {
	provide(...instances: unknown[]): LooseBuilder;
	args(...defs: unknown[]): LooseBuilder;
	flags(...defs: unknown[]): LooseBuilder;
	action(run: unknown): LooseBuilder;
}

interface IO {
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
	readonly color?: boolean;
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
				!Object.hasOwn(commandTable, first)
			) {
				const directory = await lstat(first).catch(() => null);
				if (!directory?.isDirectory())
					throw new UsageError("Unknown command or directory");
			}
		} catch (error) {
			if (!(error instanceof UsageError)) throw error;
			io.stderr(localizeUsage(peekLocale(argv), error.message));
			return 2;
		}
	}
	const appContext = layer("application", application);
	const program = Effect.gen(function* () {
		if (!invocation) return;
		const service = yield* Application;
		if (commandTable[invocation.operation].run === "diagnose") {
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
										error.code === "CONFIG_OR_TARGET_ERROR" &&
										error.detail &&
										!invocation.json
											? localizeUsage(invocation.lang, error.detail)
											: (error.detail ??
												failureMessage(invocation.lang, error.code)),
								},
							],
						};
					}),
				),
			);
			const output = present(batch, invocation, io.color);
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
						message:
							error.code === "CONFIG_OR_TARGET_ERROR" && error.detail
								? localizeUsage(invocation.lang, error.detail)
								: (error.detail ?? error.code),
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
	const configure = (command: object, spec: CommandSpec): never => {
		let builder = (command as LooseBuilder).provide(appContext());
		if (spec.target)
			builder = builder.args({
				name: spec.target.name,
				type: "string",
				description: spec.target.description,
			});
		const defs = Object.entries(spec.flags).flatMap(([name, override]) => {
			const flag = flagTable[name] as NonNullable<(typeof flagTable)[string]>;
			return flag.hidden
				? []
				: [
						{
							name,
							type: flag.type,
							description: override.description ?? flag.description,
						},
					];
		});
		return builder
			.flags(...defs)
			.action(
				handler(
					(_input: ActionInput) => program as Effect.Effect<void>,
				) as never,
			) as never;
	};
	const app = new Crust("gh-local-repo-cleaner", {
		description: "Inspect and preserve local Git repositories",
		version: pkg.version,
	})
		.add(
			...Object.entries(commandTable).map(([name, spec]) =>
				defineCommand(name, { description: spec.description }, (command) =>
					spec.subcommand
						? command.add(
								defineCommand(
									spec.subcommand.name,
									{ description: spec.subcommand.description },
									(child) => configure(child, spec),
								),
							)
						: configure(command, spec),
				),
			),
		)
		.provide(appContext())
		.action(handler(() => program))
		.extend(version(), help());
	const subcommand = invocation
		? commandTable[invocation.operation].subcommand
		: undefined;
	const normalized = invocation
		? subcommand
			? [invocation.operation, subcommand.name]
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
