import type { Finding, ReasonCode } from "../core/diagnosis.ts";

export type Locale = "en" | "ja";
export const locales: readonly Locale[] = ["en", "ja"];

// English actions come from the diagnosis itself; only other locales are tabled here.
const actionsJa = {
	PATH_SYMLINK: "シンボリックリンクのパスは手動で保全してください。",
	NESTED_REPOSITORY: "入れ子のリポジトリは手動で保全してください。",
	EXCLUDED_BY_CONFIG: "除外設定を確認してください。",
	REMOTE_CHANGED_DURING_SCAN:
		"リモートの refs が安定してから再度 scan してください。",
	UNSUPPORTED_TRANSPORT:
		"対応しているリモートのトランスポートを使ってください。",
	REMOTE_VERIFICATION_FAILED: "リモート検証の失敗を解消してください。",
	REMOTE_MISSING: "リモートを設定して検証してください。",
	DETACHED_HEAD_ONLY_COMMITS: "detached HEAD 上のコミットを保全してください。",
	LOCAL_REMOTE_DEPENDENCY: "ローカルのリモート依存を保全してください。",
	STAGED_CHANGES: "ステージ済みの変更を確認して手動で commit してください。",
	UNSTAGED_CHANGES: "作業ツリーの変更を保存して手動で commit してください。",
	UNTRACKED_FILES: "未追跡ファイルを追跡するか、別途保存してください。",
	EXTERNAL_GIT_STORAGE: "外部の Git ストレージは手動で保全してください。",
	HIDDEN_INDEX_STATE:
		"assume-unchanged / skip-worktree のファイルを確認してください。",
	OPERATION_IN_PROGRESS: "進行中の Git 操作を手動で完了してください。",
	UNSUPPORTED_REFS: "replace・graft などの未対応 refs を保全してください。",
	UNBORN_HEAD: "最初のコミットを手動で作成してください。",
	REFLOG_ONLY_COMMITS: "クリーン前に reflog の履歴を保全してください。",
	UNREACHABLE_OBJECTS:
		"クリーン前に到達不能な Git オブジェクトを保全してください。",
	STATE_CHANGED: "並行する書き込みを止めて、再度検査してください。",
	UNPUSHED_COMMITS: "ローカルのコミットをすべて保全するか push してください。",
	REMOTE_DEPENDENCY:
		"クリーン対象外のローカルのリモート依存を保全してください。",
	LOCAL_CHANGES:
		"ステージ済み・未ステージ・未追跡のファイルを commit または保存してください。",
	IGNORED_FILES: "クリーン前に ignored ファイルを保存してください。",
	STASH_PRESENT: "stash を保存するか適用してください。",
	LOCAL_TAG_ONLY: "ローカルタグを確認して保全してください。",
	DETACHED_HEAD: "detached HEAD にブランチを作成してください。",
	WORKTREE_PRESENT: "追加の worktree を保全して切り離してください。",
	SUBMODULE_PRESENT: "submodule は手動で保全してください。",
	EXCLUDED: "除外設定を確認してください。",
	UNSUPPORTED_LAYOUT: "未対応の Git 構成は手動で保全してください。",
	UPSTREAM_MISSING:
		"すべてのローカルブランチに upstream を設定して検証してください。",
	NO_REMOTE: "リモートを設定して検証してください。",
	LOCAL_INSPECTION_FAILED: "検査の失敗を解消して、再度 scan してください。",
	ONLINE_NOT_VERIFIED: "現在のリモート refs に対する到達性を検証してください。",
} as const satisfies Record<ReasonCode, string>;

const labels = {
	en: {
		source: (source: string, root: string, name: string) =>
			`  Source: ${source}; root: ${root}; name: ${name}`,
		checkedAt: (value: string) => `  Checked at: ${value}`,
		repository: (size: number | null, commit: string | null) =>
			`  Logical bytes (estimate): ${size ?? "unknown"}; last commit: ${commit ?? "unknown"}`,
		safeSize: (bytes: number, unknown: number) =>
			`SAFE logical bytes (estimate): ${bytes}; unknown sizes: ${unknown}`,
		totals: (scanned: number, returned: number, counts: readonly string[]) =>
			`Scanned ${scanned}; returned ${returned}; ${counts.join("; ")}`,
	},
	ja: {
		source: (source: string, root: string, name: string) =>
			`  取得元: ${source}; ルート: ${root}; 名前: ${name}`,
		checkedAt: (value: string) => `  検査日時: ${value}`,
		repository: (size: number | null, commit: string | null) =>
			`  論理サイズ(概算): ${size ?? "不明"} バイト; 最終コミット: ${commit ?? "不明"}`,
		safeSize: (bytes: number, unknown: number) =>
			`SAFE の論理サイズ(概算): ${bytes} バイト; サイズ不明: ${unknown} 件`,
		totals: (scanned: number, returned: number, counts: readonly string[]) =>
			`検査 ${scanned} 件; 表示 ${returned} 件; ${counts.join("; ")}`,
	},
} as const;

const failures = {
	en: {
		SERVICE_NOT_CONNECTED: "Required application service is unavailable.",
		GHQ_NOT_FOUND: "ghq was not found; install ghq or specify a directory.",
		GHQ_TIMEOUT: "ghq timed out while listing repositories.",
		GHQ_COMMAND_FAILED: "ghq failed while listing repositories.",
		DISCOVERY_FAILED: "Repository enumeration failed.",
		CONFIG_OR_TARGET_ERROR: "Invalid configuration or target.",
		DIAGNOSIS_FAILED: "Diagnosis failed.",
	},
	ja: {
		SERVICE_NOT_CONNECTED: "必要なアプリケーションサービスが利用できません。",
		GHQ_NOT_FOUND:
			"ghq が見つかりません。ghq をインストールするか、ディレクトリを指定してください。",
		GHQ_TIMEOUT: "リポジトリ一覧の取得中に ghq がタイムアウトしました。",
		GHQ_COMMAND_FAILED: "リポジトリ一覧の取得中に ghq が失敗しました。",
		DISCOVERY_FAILED: "リポジトリの列挙に失敗しました。",
		CONFIG_OR_TARGET_ERROR: "設定または対象が不正です。",
		DIAGNOSIS_FAILED: "診断に失敗しました。",
	},
} as const satisfies Record<Locale, Record<string, string>>;

export const text = (locale: Locale) => labels[locale];

export const failureMessage = (locale: Locale, code: string) =>
	(failures[locale] as Record<string, string>)[code] ??
	failures[locale].DIAGNOSIS_FAILED;

// Text after the reason code; ja replaces the code-derived English message.
export function describeReason(locale: Locale, reason: Finding) {
	if (locale === "en") return `${reason.message}; ${reason.action}`;
	const branch =
		reason.branch !== undefined && reason.commit_count !== undefined
			? `${reason.branch}: 未保全コミット ${reason.commit_count} 件; `
			: "";
	return `${branch}${actionsJa[reason.code]}`;
}

// Usage errors are thrown as English text from several layers, so ja is matched on that text.
const usageJa: readonly (readonly [
	RegExp,
	(match: RegExpMatchArray) => string,
])[] = [
	[
		/^Unknown command or directory$/,
		() => "不明なコマンドまたはディレクトリです。",
	],
	[
		/^Flag is not supported for this command$/,
		() => "このコマンドでは使えないフラグです。",
	],
	[
		/^Directory and --ghq cannot be combined$/,
		() => "ディレクトリと --ghq は併用できません。",
	],
	[/^Invalid status$/, () => "--status の値が不正です。"],
	[/^Invalid --group-by value$/, () => "--group-by の値が不正です。"],
	[/^Invalid --lang value$/, () => "--lang の値が不正です。"],
	[
		/^--state-dir requires an absolute path$/,
		() => "--state-dir には絶対パスが必要です。",
	],
	[
		/^Duplicate or malformed flag$/,
		() => "フラグが重複しているか、形式が不正です。",
	],
	[
		/^Boolean flag does not accept a value$/,
		() => "真偽値フラグは値を取りません。",
	],
	[/^Flag requires a value$/, () => "フラグには値が必要です。"],
	[/^Unknown flag$/, () => "未知のフラグです。"],
	[
		/^--delete requires a directory shorthand$/,
		() => "--delete にはディレクトリの省略形が必要です。",
	],
	[/^Usage: trash list$/, () => "使い方: trash list"],
	[/^Too many arguments$/, () => "引数が多すぎます。"],
	[/^Target required$/, () => "対象の指定が必要です。"],
	[
		/^ID must be 32 lowercase hexadecimal characters$/,
		() => "ID は小文字16進数32文字で指定してください。",
	],
	[/^Directory required$/, () => "ディレクトリの指定が必要です。"],
	[
		/^Non-interactive restore requires --yes$/,
		() => "非対話で restore するには --yes が必要です。",
	],
	[
		/^Non-interactive clean requires --yes$/,
		() => "非対話で clean するには --yes が必要です。",
	],
	[
		/^Non-interactive operation requires --yes$/,
		() => "非対話で実行するには --yes が必要です。",
	],
	[
		/^Invalid or unreadable configuration$/,
		() => "設定が不正、または読み取れません。",
	],
	[
		/^Path is not a Git worktree root; specify the repository root itself$/,
		() =>
			"パスが Git ワークツリーのルートではありません。リポジトリのルートそのものを指定してください。",
	],
	[
		/^Directory does not exist or is not a directory$/,
		() => "ディレクトリが存在しないか、ディレクトリではありません。",
	],
	[
		/^No ghq repository is named (".*"); use an absolute path, \.\/ or \.\.\/ for other repositories$/,
		(m) =>
			`${m[1]} という名前の ghq リポジトリはありません。他のリポジトリは絶対パス、./、../ で指定してください。`,
	],
	[
		/^Repository name (".*") is ambiguous across ghq roots \((.*)\); specify an absolute path$/,
		(m) =>
			`リポジトリ名 ${m[1]} は ghq のルートをまたいで曖昧です (${m[2]})。絶対パスで指定してください。`,
	],
];

export function localizeUsage(locale: Locale, message: string) {
	if (locale === "en") return message;
	for (const [pattern, translate] of usageJa) {
		const match = message.match(pattern);
		if (match) return translate(match);
	}
	return message;
}

// Argument parsing may fail before the invocation exists, so its errors read the flag directly.
export function peekLocale(argv: readonly string[]): Locale {
	const end = argv.indexOf("--");
	const options = argv.slice(0, end < 0 ? argv.length : end);
	const index = options.findIndex(
		(arg) => arg === "--lang" || arg.startsWith("--lang="),
	);
	const value =
		options[index]?.split("=")[1] ??
		(index < 0 ? undefined : options[index + 1]);
	return locales.find((locale) => locale === value) ?? "en";
}
