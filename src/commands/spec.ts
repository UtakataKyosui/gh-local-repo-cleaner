import { locales } from "./messages.ts";

interface FlagSpec {
	readonly type: "boolean" | "string";
	readonly description: string;
	readonly values?: readonly string[];
	readonly invalid?: string;
	readonly absolutePath?: boolean;
	readonly excludesTarget?: boolean;
	readonly hidden?: boolean;
}

// Validation runs in this order, so keep status, group-by, lang, state-dir in sequence.
const flagSpecs = {
	json: { type: "boolean", description: "Output as JSON" },
	yes: {
		type: "boolean",
		description: "Move without asking for confirmation",
	},
	"dry-run": {
		type: "boolean",
		description: "Show what would be moved without changing anything",
	},
	ghq: {
		type: "boolean",
		description: "Use all repositories listed by ghq",
		excludesTarget: true,
	},
	delete: {
		type: "boolean",
		description: "Shorthand for clean when given a directory",
		hidden: true,
	},
	config: {
		type: "string",
		description: "Path to a config file replacing the default",
	},
	status: {
		type: "string",
		description: "Show only repositories with this status",
		values: ["safe", "dirty", "protected", "unknown"],
		invalid: "Invalid status",
	},
	"group-by": {
		type: "string",
		description: "Group output by language (marker-file based)",
		values: ["language"],
		invalid: "Invalid --group-by value",
	},
	lang: {
		type: "string",
		description: "Display language of messages: en or ja",
		values: locales,
		invalid: "Invalid --lang value",
	},
	"state-dir": {
		type: "string",
		description: "Absolute path of the state directory",
		absolutePath: true,
	},
} as const satisfies Record<string, FlagSpec>;

type FlagName = keyof typeof flagSpecs;

export interface CommandSpec {
	readonly description: string;
	// "interactive" runs the TUI, which needs a terminal on both stdin and stdout.
	readonly run: "diagnose" | "operate" | "interactive";
	readonly subcommand?: {
		readonly name: string;
		readonly description: string;
	};
	readonly target?: {
		readonly name: string;
		readonly description: string;
		readonly required: boolean;
		readonly pattern?: { readonly regex: RegExp; readonly message: string };
	};
	// `<directory> --<shorthand>` selects this command without naming it.
	readonly shorthand?: FlagName;
	readonly flags: {
		readonly [Name in FlagName]?: { readonly description?: string };
	};
}

const commands = {
	scan: {
		description: "Diagnose repositories (read-only)",
		run: "diagnose",
		target: {
			name: "directory",
			description:
				"Directory whose direct children are scanned (default: all ghq repositories)",
			required: false,
		},
		flags: {
			json: {},
			ghq: { description: "Scan all repositories listed by ghq" },
			config: {},
			"group-by": {},
			lang: { description: "Display language of the text output: en or ja" },
		},
	},
	list: {
		description: "List diagnosed repositories (read-only)",
		run: "diagnose",
		target: {
			name: "directory",
			description:
				"Directory whose direct children are listed (default: all ghq repositories)",
			required: false,
		},
		flags: {
			json: {},
			ghq: { description: "List all repositories listed by ghq" },
			config: {},
			status: {},
			"group-by": {},
			lang: { description: "Display language of the text output: en or ja" },
		},
	},
	inspect: {
		description: "Show the diagnosis of one repository (read-only)",
		run: "diagnose",
		target: {
			name: "target",
			description:
				"Repository path (absolute, ./ or ../) or ghq name such as github.com/owner/repo",
			required: true,
		},
		flags: {
			json: {},
			config: {},
			lang: { description: "Display language of the text output: en or ja" },
		},
	},
	clean: {
		description: "Move SAFE repositories to the trash so they can be restored",
		run: "operate",
		target: {
			name: "directory",
			description:
				"Directory whose direct children are cleaned (default: all ghq repositories)",
			required: false,
		},
		shorthand: "delete",
		flags: {
			yes: {},
			"dry-run": {},
			ghq: { description: "Clean repositories listed by ghq" },
			config: {},
			"state-dir": {},
			lang: {},
			delete: {},
		},
	},
	trash: {
		description: "Inspect repositories moved by clean",
		run: "operate",
		subcommand: {
			name: "list",
			description: "List trashed repositories and their states",
		},
		flags: { "state-dir": {}, lang: {} },
	},
	restore: {
		description: "Move a trashed repository back to its original path",
		run: "operate",
		target: {
			name: "id",
			description: "Trash entry ID shown by trash list",
			required: true,
			pattern: {
				regex: /^[0-9a-f]{32}$/,
				message: "ID must be 32 lowercase hexadecimal characters",
			},
		},
		flags: {
			yes: { description: "Restore without asking for confirmation" },
			"state-dir": {},
			lang: {},
		},
	},
	tui: {
		description:
			"Browse, clean and restore repositories in an interactive terminal UI",
		run: "interactive",
		target: {
			name: "directory",
			description:
				"Directory whose direct children are shown (default: the last one used, else all ghq repositories)",
			required: false,
		},
		flags: {
			ghq: { description: "Show all repositories listed by ghq" },
			config: {},
			status: { description: "Start with only this status shown" },
			"group-by": { description: "Start grouped by language" },
			lang: {},
			"state-dir": {},
		},
	},
} as const satisfies Record<string, CommandSpec>;

export type Operation = keyof typeof commands;

export const flagTable: Readonly<Record<string, FlagSpec>> = flagSpecs;
export const commandTable: Readonly<Record<Operation, CommandSpec>> = commands;
