import { isAbsolute } from "node:path";
import type { Locale } from "./messages.ts";
import {
	type CommandSpec,
	commandTable,
	flagTable,
	type Operation,
} from "./spec.ts";

export interface Invocation {
	readonly operation: Operation;
	readonly target?: string;
	readonly json: boolean;
	readonly yes: boolean;
	readonly dryRun: boolean;
	readonly ghq: boolean;
	readonly status?: "safe" | "dirty" | "protected" | "unknown";
	readonly groupBy?: "language";
	readonly lang: Locale;
	// lang falls back to en, so the TUI needs this to let a saved language win.
	readonly langGiven: boolean;
	readonly config?: string;
	readonly stateDir?: string;
	// Set only by the TUI: clean considers just these repository paths.
	readonly only?: readonly string[];
}
export class UsageError extends Error {}

export const nonInteractiveTui =
	"tui requires an interactive terminal; use scan, list, inspect, clean, trash list or restore instead";

function isOperation(value: string | undefined): value is Operation {
	return value !== undefined && Object.hasOwn(commandTable, value);
}

export function normalizeArguments(argv: readonly string[]): Invocation {
	const positional: string[] = [];
	const flags = new Map<string, string | true>();
	let literal = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		if (arg === "--" && !literal) {
			literal = true;
			continue;
		}
		if (!literal && arg.startsWith("-")) {
			const equals = arg.indexOf("=");
			const option = equals < 0 ? arg : arg.slice(0, equals);
			const inline = equals < 0 ? undefined : arg.slice(equals + 1);
			const name = option.slice(2);
			const spec =
				option.startsWith("--") && Object.hasOwn(flagTable, name)
					? flagTable[name]
					: undefined;
			if (!spec) throw new UsageError("Unknown flag");
			if (flags.has(name)) throw new UsageError("Duplicate or malformed flag");
			if (spec.type === "boolean") {
				if (inline !== undefined)
					throw new UsageError("Boolean flag does not accept a value");
				flags.set(name, true);
			} else {
				const value = inline ?? argv[++index];
				if (!value || value.startsWith("--"))
					throw new UsageError("Flag requires a value");
				flags.set(name, value);
			}
		} else positional.push(arg);
	}
	const first = positional[0];
	const explicit = isOperation(first);
	const shorthand = Object.entries(commandTable).find(
		([, command]) => command.shorthand && flags.has(command.shorthand),
	);
	let operation: Operation = explicit
		? (positional.shift() as Operation)
		: "scan";
	if (shorthand) {
		if (explicit)
			throw new UsageError(
				`--${shorthand[1].shorthand} requires a directory shorthand`,
			);
		operation = shorthand[0] as Operation;
	}
	const spec = commandTable[operation] as CommandSpec;
	if (spec.subcommand && positional.shift() !== spec.subcommand.name)
		throw new UsageError(`Usage: ${operation} ${spec.subcommand.name}`);
	if (positional.length > (spec.target ? 1 : 0))
		throw new UsageError("Too many arguments");
	const target = positional[0];
	if (spec.target?.required && !target) throw new UsageError("Target required");
	if (spec.target?.pattern && !spec.target.pattern.regex.test(target ?? ""))
		throw new UsageError(spec.target.pattern.message);
	if (shorthand && !target) throw new UsageError("Directory required");
	for (const flag of flags.keys())
		if (!Object.hasOwn(spec.flags, flag))
			throw new UsageError("Flag is not supported for this command");
	for (const [name, flag] of Object.entries(flagTable))
		if (flag.excludesTarget && flags.has(name) && target)
			throw new UsageError(`Directory and --${name} cannot be combined`);
	for (const [name, flag] of Object.entries(flagTable)) {
		const value = flags.get(name);
		if (typeof value !== "string") continue;
		if (flag.values && !flag.values.includes(value))
			throw new UsageError(flag.invalid ?? `Invalid --${name} value`);
		if (flag.absolutePath && !isAbsolute(value))
			throw new UsageError(`--${name} requires an absolute path`);
	}
	return {
		operation,
		target,
		json: flags.has("json"),
		yes: flags.has("yes"),
		dryRun: flags.has("dry-run"),
		ghq: flags.has("ghq"),
		status: flags.get("status") as Invocation["status"],
		groupBy: flags.get("group-by") as Invocation["groupBy"],
		lang: (flags.get("lang") ?? "en") as Locale,
		langGiven: flags.has("lang"),
		config: flags.get("config") as string | undefined,
		stateDir: flags.get("state-dir") as string | undefined,
	};
}
