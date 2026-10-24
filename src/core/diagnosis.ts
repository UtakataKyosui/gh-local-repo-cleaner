export type Status = "SAFE" | "DIRTY" | "PROTECTED" | "UNKNOWN";

const reasons = {
	STAGED_CHANGES: ["DIRTY", "Review and commit staged changes manually."],
	UNSTAGED_CHANGES: ["DIRTY", "Save and commit worktree changes manually."],
	UNTRACKED_FILES: ["DIRTY", "Track or separately save untracked files."],
	EXTERNAL_GIT_STORAGE: [
		"PROTECTED",
		"Preserve external Git storage manually.",
	],
	HIDDEN_INDEX_STATE: [
		"PROTECTED",
		"Review assume-unchanged and skip-worktree files.",
	],
	OPERATION_IN_PROGRESS: [
		"PROTECTED",
		"Complete the in-progress Git operation manually.",
	],
	UNSUPPORTED_REFS: [
		"PROTECTED",
		"Preserve replacement, graft and unsupported refs.",
	],
	UNBORN_HEAD: ["PROTECTED", "Create the initial commit manually."],
	REFLOG_ONLY_COMMITS: [
		"PROTECTED",
		"Preserve reflog history before cleaning.",
	],
	UNREACHABLE_OBJECTS: [
		"PROTECTED",
		"Preserve unreachable Git objects before cleaning.",
	],
	STATE_CHANGED: ["UNKNOWN", "Stop concurrent writers and inspect again."],
	UNPUSHED_COMMITS: ["DIRTY", "Preserve or push all local commits manually."],
	REMOTE_DEPENDENCY: [
		"PROTECTED",
		"Preserve local remote dependencies outside the clean target set.",
	],
	LOCAL_CHANGES: [
		"DIRTY",
		"Commit or save staged, unstaged and untracked files.",
	],
	IGNORED_FILES: ["PROTECTED", "Save ignored files before cleaning."],
	STASH_PRESENT: ["PROTECTED", "Save or apply stash entries."],
	LOCAL_TAG_ONLY: ["PROTECTED", "Verify and preserve local tags."],
	DETACHED_HEAD: ["PROTECTED", "Create a branch for the detached HEAD."],
	WORKTREE_PRESENT: [
		"PROTECTED",
		"Preserve and detach additional worktrees manually.",
	],
	SUBMODULE_PRESENT: ["PROTECTED", "Preserve submodules manually."],
	EXCLUDED: ["PROTECTED", "Review the exclusion configuration."],
	UNSUPPORTED_LAYOUT: [
		"PROTECTED",
		"Preserve this unsupported Git layout manually.",
	],
	UPSTREAM_MISSING: [
		"PROTECTED",
		"Configure and verify upstreams for every local branch.",
	],
	NO_REMOTE: ["UNKNOWN", "Configure and verify a remote."],
	LOCAL_INSPECTION_FAILED: [
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
	readonly message: string;
}

export const finding = (code: ReasonCode): Finding => ({
	code,
	status: reasons[code][0],
	action: reasons[code][1],
	message: code.toLowerCase().replaceAll("_", " "),
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
