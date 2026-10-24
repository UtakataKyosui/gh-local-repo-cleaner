export type Status = "SAFE" | "DIRTY" | "PROTECTED" | "UNKNOWN";

const reasons = {
	LOCAL_CHANGES: [
		"DIRTY",
		"Commit or save staged, unstaged and untracked files.",
	],
	IGNORED_FILES: ["PROTECTED", "Save ignored files before cleaning."],
	STASH: ["PROTECTED", "Save or apply stash entries."],
	LOCAL_TAGS: ["PROTECTED", "Verify and preserve local tags."],
	DETACHED_HEAD: ["PROTECTED", "Create a branch for the detached HEAD."],
	EXTRA_WORKTREES: [
		"PROTECTED",
		"Preserve and detach additional worktrees manually.",
	],
	SUBMODULES: ["PROTECTED", "Preserve submodules manually."],
	EXCLUDED: ["PROTECTED", "Review the exclusion configuration."],
	UNSUPPORTED_LAYOUT: [
		"PROTECTED",
		"Preserve this unsupported Git layout manually.",
	],
	MISSING_UPSTREAM: [
		"PROTECTED",
		"Configure and verify upstreams for every local branch.",
	],
	NO_REMOTE: ["UNKNOWN", "Configure and verify a remote."],
	INSPECTION_FAILED: [
		"UNKNOWN",
		"Resolve the inspection failure and scan again.",
	],
	ONLINE_NOT_VERIFIED: [
		"UNKNOWN",
		"Verify reachability against current remote refs.",
	],
} as const satisfies Record<string, readonly [Status, string]>;

export type ReasonCode = keyof typeof reasons;
export interface Finding {
	readonly code: ReasonCode;
	readonly status: Status;
	readonly action: string;
}

export const finding = (code: ReasonCode): Finding => ({
	code,
	status: reasons[code][0],
	action: reasons[code][1],
});

export interface Diagnosis {
	readonly schema_version: 1;
	readonly path: string;
	readonly status: Status;
	readonly reasons: readonly Finding[];
}

const priority: Record<Status, number> = {
	SAFE: 0,
	DIRTY: 1,
	PROTECTED: 2,
	UNKNOWN: 3,
};

export function diagnose(
	path: string,
	findings: readonly Finding[],
): Diagnosis {
	const unique = [
		...new Map(findings.map((item) => [item.code, item])).values(),
	];
	return {
		schema_version: 1,
		path,
		status: unique.reduce<Status>(
			(status, item) =>
				priority[item.status] > priority[status] ? item.status : status,
			"SAFE",
		),
		reasons: unique,
	};
}
