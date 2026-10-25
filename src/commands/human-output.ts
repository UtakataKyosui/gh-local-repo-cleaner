import { relative, sep } from "node:path";
import type { Finding, ReasonCode } from "../core/diagnosis.ts";
import type { Assessment } from "../model/assessment.ts";
import type { Invocation } from "./arguments.ts";
import { reasonAction, reasonDetail, text } from "./messages.ts";
import { createPainter } from "./palette.ts";

// Quote every path component: whitespace, controls and tree glyphs cannot forge rows.
export const quote = (value: string) =>
	JSON.stringify(value).replace(
		/[\p{Cf}\u007f-\u009f\u2028\u2029]/gu,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
const namesJa: Record<ReasonCode, string> = {
	PATH_SYMLINK: "シンボリックリンク",
	NESTED_REPOSITORY: "入れ子のリポジトリ",
	EXCLUDED_BY_CONFIG: "設定による除外",
	REMOTE_CHANGED_DURING_SCAN: "検査中にリモート変更",
	UNSUPPORTED_TRANSPORT: "未対応の通信方式",
	REMOTE_VERIFICATION_FAILED: "リモート検証失敗",
	REMOTE_MISSING: "リモートなし",
	DETACHED_HEAD_ONLY_COMMITS: "detached HEAD の未保全コミット",
	LOCAL_REMOTE_DEPENDENCY: "ローカルリモート依存",
	STAGED_CHANGES: "ステージ済み変更",
	UNSTAGED_CHANGES: "作業変更",
	UNTRACKED_FILES: "未追跡ファイル",
	EXTERNAL_GIT_STORAGE: "外部 Git ストレージ",
	HIDDEN_INDEX_STATE: "非表示のインデックス状態",
	OPERATION_IN_PROGRESS: "Git 操作中",
	UNSUPPORTED_REFS: "未対応 ref",
	UNBORN_HEAD: "初回コミットなし",
	REFLOG_ONLY_COMMITS: "reflog のみのコミット",
	UNREACHABLE_OBJECTS: "到達不能オブジェクト",
	STATE_CHANGED: "検査中に状態変更",
	UNPUSHED_COMMITS: "未保全ref",
	REMOTE_DEPENDENCY: "リモート依存",
	LOCAL_CHANGES: "作業変更あり",
	IGNORED_FILES: "ignored ファイル",
	STASH_PRESENT: "stashあり",
	LOCAL_TAG_ONLY: "ローカルのみのタグ",
	DETACHED_HEAD: "detached HEAD",
	WORKTREE_PRESENT: "worktreeあり",
	SUBMODULE_PRESENT: "submoduleあり",
	EXCLUDED: "除外",
	UNSUPPORTED_LAYOUT: "未対応の Git 構成",
	UPSTREAM_MISSING: "upstream 未設定",
	NO_REMOTE: "リモート未設定",
	LOCAL_INSPECTION_FAILED: "ローカル検査失敗",
	ONLINE_NOT_VERIFIED: "オンライン未検証",
};

export function formatSize(bytes: number | null, ja: boolean): string {
	if (bytes === null) return ja ? "サイズ不明" : "size unknown";
	const unit =
		bytes < 1024
			? 0
			: Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
	return `${Number((bytes / 1024 ** unit).toFixed(2))} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`;
}

function compact(reasons: readonly Finding[], ja: boolean) {
	const groups = new Map<string, Finding[]>();
	const noRemote = reasons.some(
		(r) => r.code === "NO_REMOTE" || r.code === "REMOTE_MISSING",
	);
	for (const reason of reasons) {
		const key =
			noRemote &&
			["NO_REMOTE", "REMOTE_MISSING", "ONLINE_NOT_VERIFIED"].includes(
				reason.code,
			)
				? "NO_REMOTE"
				: [
							"LOCAL_CHANGES",
							"STAGED_CHANGES",
							"UNSTAGED_CHANGES",
							"UNTRACKED_FILES",
						].includes(reason.code)
					? "LOCAL_CHANGES"
					: reason.code;
		groups.set(key, [...(groups.get(key) ?? []), reason]);
	}
	const entries = [...groups];
	const summary = entries.slice(0, 3).map(([code, findings]) => {
		const refs = findings.filter((f) => f.branch !== undefined).length;
		return `${ja ? namesJa[code as ReasonCode] : code.toLowerCase().replaceAll("_", " ")}${refs ? (ja ? (code === "UNPUSHED_COMMITS" ? ` ${refs}件` : ` ${refs}件のref`) : ` (${refs} refs)`) : ""}`;
	});
	const hidden = entries
		.slice(3)
		.reduce(
			(count, [, findings]) =>
				count + new Set(findings.map((f) => f.code)).size,
			0,
		);
	if (hidden)
		summary.push(
			ja ? `ほか${hidden}種類の理由` : `${hidden} more reason types`,
		);
	return summary.join(" · ");
}

export function humanOutput(
	repositories: readonly Assessment[],
	invocation: Pick<Invocation, "operation" | "groupBy" | "lang">,
	summary: string[],
	color: boolean,
) {
	const ja = invocation.lang === "ja";
	const labels = text(invocation.lang);
	const paint = createPainter(color);
	const row = (repo: Assessment, name: string) =>
		`${name} [${paint(repo.status, repo.status)}] ${formatSize(repo.metadata.size_bytes, ja)}`;
	const lines = [...summary, ""];
	if (invocation.operation === "inspect") {
		for (const repo of repositories) {
			lines.push(
				`${paint(repo.status, repo.status)} ${quote(repo.repository.path)}`,
				labels.source(
					repo.repository.source,
					quote(repo.repository.root),
					quote(repo.repository.name),
				),
				labels.checkedAt(repo.checked_at),
			);
			const commit =
				repo.metadata.last_commit_at ??
				(repo.metadata.last_commit_status === "none"
					? ja
						? "コミットなし"
						: "no commits"
					: ja
						? "取得失敗 / 不明"
						: "unavailable");
			lines.push(labels.repository(repo.metadata.size_bytes, commit));
			lines.push(
				...(repo.metadata.metadata_errors ?? []).map((e) => `  ${quote(e)}`),
			);
			for (const [code, findings] of Map.groupBy(repo.reasons, (r) => r.code)) {
				const first = findings[0];
				if (!first) continue;
				const refs = findings.filter((r) => r.branch !== undefined).length;
				lines.push(
					`  [${paint(first.status, first.status)}] ${code}${ja ? ` — ${namesJa[code]}` : ""}${refs ? ` (${refs} refs)` : ""}`,
				);
				for (const reason of findings) {
					const detail = reasonDetail(invocation.lang, reason);
					if (detail !== undefined) lines.push(`    - ${quote(detail)}`);
					if (reason.rule_index !== undefined)
						lines.push(`    rule_index: ${reason.rule_index}`);
				}
				lines.push(`    → ${reasonAction(invocation.lang, first)}`);
			}
		}
	} else {
		const grouped = invocation.groupBy
			? Map.groupBy(repositories, (r) => r.metadata.language ?? "Other")
			: new Map([["", [...repositories]]]);
		for (const [language, repos] of grouped) {
			if (invocation.groupBy)
				lines.push(
					`== ${quote(language)} (${["SAFE", "DIRTY", "PROTECTED", "UNKNOWN"].map((s) => `${s} ${repos.filter((r) => r.status === s).length}`).join("; ")}) ==`,
				);
			if (invocation.operation === "list") {
				for (const repo of repos)
					lines.push(
						`${row(repo, quote(repo.repository.path))} · ${compact(repo.reasons, ja)}`,
					);
				continue;
			}
			for (const [root, items] of Map.groupBy(
				repos,
				(r) => r.repository.root,
			)) {
				lines.push(`${quote(root)} /`);
				interface Node {
					children: Map<string, Node>;
					repos: Assessment[];
				}
				const tree: Node = { children: new Map(), repos: [] };
				for (const repo of items) {
					let node = tree;
					const rel = relative(root, repo.repository.path);
					// Out-of-root repositories retain their absolute identity as one quoted leaf.
					const parts =
						rel === ".." || rel.startsWith(`..${sep}`)
							? [repo.repository.path]
							: rel.split(sep);
					for (const part of parts) {
						if (!node.children.has(part))
							node.children.set(part, { children: new Map(), repos: [] });
						node = node.children.get(part) as Node;
					}
					node.repos.push(repo);
				}
				const visit = (node: Node, prefix: string) => {
					const children = [...node.children];
					children.forEach(([name, child], index) => {
						const last = index === children.length - 1;
						const indent = `${prefix}${last ? "    " : "│   "}`;
						lines.push(
							`${prefix}${last ? "└── " : "├── "}${child.repos.length ? child.repos.map((repo) => row(repo, quote(name))).join("; ") : `${quote(name)}/`}`,
						);
						for (const repo of child.repos) {
							const reasons = compact(repo.reasons, ja);
							if (reasons) lines.push(`${indent}${reasons}`);
						}
						visit(child, indent);
					});
				};
				visit(tree, "");
			}
		}
		if (!repositories.length)
			lines.push(ja ? "対象のリポジトリはありません。" : "No repositories.");
		lines.push(
			"",
			ja ? "詳細: inspect <リポジトリ>" : "Details: inspect <repository>",
			ja ? "全データ: scan --json" : "All data: scan --json",
		);
	}
	return lines.join("\n");
}
