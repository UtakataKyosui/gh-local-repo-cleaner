import { isAbsolute } from "node:path";

export type Operation =
	| "scan"
	| "list"
	| "inspect"
	| "clean"
	| "trash"
	| "restore";
export interface Invocation {
	readonly operation: Operation;
	readonly target?: string;
	readonly json: boolean;
	readonly yes: boolean;
	readonly dryRun: boolean;
	readonly ghq: boolean;
	readonly status?: "safe" | "dirty" | "protected" | "unknown";
	readonly groupBy?: "language";
	readonly config?: string;
	readonly stateDir?: string;
}
export class UsageError extends Error {}

const operations = new Set([
	"scan",
	"list",
	"inspect",
	"clean",
	"trash",
	"restore",
]);
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
			const name = equals < 0 ? arg : arg.slice(0, equals);
			const inline = equals < 0 ? undefined : arg.slice(equals + 1);
			if (!name || flags.has(name))
				throw new UsageError("Duplicate or malformed flag");
			if (
				["--json", "--yes", "--dry-run", "--ghq", "--delete"].includes(name)
			) {
				if (inline !== undefined)
					throw new UsageError("Boolean flag does not accept a value");
				flags.set(name, true);
			} else if (
				["--status", "--config", "--state-dir", "--group-by"].includes(name)
			) {
				const value = inline ?? argv[++index];
				if (!value || value.startsWith("--"))
					throw new UsageError("Flag requires a value");
				flags.set(name, value);
			} else throw new UsageError("Unknown flag");
		} else positional.push(arg);
	}
	const first = positional[0];
	const explicit = !!first && operations.has(first);
	let operation = (explicit ? positional.shift() : "scan") as Operation;
	if (!explicit && flags.has("--delete")) operation = "clean";
	else if (flags.has("--delete"))
		throw new UsageError("--delete requires a directory shorthand");
	if (operation === "trash" && positional.shift() !== "list")
		throw new UsageError("Usage: trash list");
	if (positional.length > 1 || (operation === "trash" && positional.length))
		throw new UsageError("Too many arguments");
	const target = positional[0];
	if (["inspect", "restore"].includes(operation) && !target)
		throw new UsageError("Target required");
	if (operation === "restore" && !/^[0-9a-f]{32}$/.test(target ?? ""))
		throw new UsageError("ID must be 32 lowercase hexadecimal characters");
	if (flags.has("--delete") && !target)
		throw new UsageError("Directory required");
	const allowed: Record<Operation, readonly string[]> = {
		scan: ["--json", "--ghq", "--config", "--group-by"],
		list: ["--json", "--ghq", "--config", "--status", "--group-by"],
		inspect: ["--json", "--config"],
		clean: [
			"--yes",
			"--dry-run",
			"--ghq",
			"--config",
			"--state-dir",
			"--delete",
		],
		trash: ["--state-dir"],
		restore: ["--yes", "--state-dir"],
	};
	for (const flag of flags.keys())
		if (!allowed[operation].includes(flag))
			throw new UsageError("Flag is not supported for this command");
	if (flags.has("--ghq") && target)
		throw new UsageError("Directory and --ghq cannot be combined");
	const status = flags.get("--status");
	if (
		status &&
		!["safe", "dirty", "protected", "unknown"].includes(String(status))
	)
		throw new UsageError("Invalid status");
	const groupBy = flags.get("--group-by");
	if (groupBy && groupBy !== "language")
		throw new UsageError("Invalid --group-by value");
	const stateDir = flags.get("--state-dir");
	if (typeof stateDir === "string" && !isAbsolute(stateDir))
		throw new UsageError("--state-dir requires an absolute path");
	return {
		operation,
		target,
		json: flags.has("--json"),
		yes: flags.has("--yes"),
		dryRun: flags.has("--dry-run"),
		ghq: flags.has("--ghq"),
		status: status as Invocation["status"],
		groupBy: groupBy as Invocation["groupBy"],
		config: flags.get("--config") as string | undefined,
		stateDir: stateDir as string | undefined,
	};
}
