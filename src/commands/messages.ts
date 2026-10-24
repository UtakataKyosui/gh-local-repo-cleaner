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
		more: (count: number) => `    - ... and ${count} more`,
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
		more: (count: number) => `    - …ほか ${count} 件`,
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

export const reasonAction = (locale: Locale, reason: Finding) =>
	locale === "en" ? reason.action : actionsJa[reason.code];

// The per-finding line under a reason code; findings without a branch have none.
export function reasonDetail(locale: Locale, reason: Finding) {
	if (reason.branch === undefined) return undefined;
	if (reason.commit_count === undefined) return reason.branch;
	return locale === "en"
		? `${reason.branch}: ${reason.commit_count} unpreserved commits`
		: `${reason.branch}: 未保全コミット ${reason.commit_count} 件`;
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

interface CleanText {
	moveNotice: string;
	moveHint: (code: string) => string;
	kept: (path: string, status: string, codes: string) => string;
	wouldMove: (
		path: string,
		destination: string,
		bytes: number | null,
	) => string;
	prompt: (path: string, destination: string) => string;
	skipped: (path: string) => string;
	moved: (path: string, id: string, destination: string) => string;
	stopped: string;
	stateStore: (path: string) => string;
	dryRunSummary: (would: number, kept: number) => string;
	summary: (
		moved: number,
		skipped: number,
		kept: number,
		failed: number,
	) => string;
	review: string;
	empty: string;
	incomplete: string;
}

const cleanTexts = {
	en: {
		moveNotice:
			"Moving within one filesystem frees no disk space; the lock does not stop editors, Git or other external writers, so do not run this on repositories in use.",
		moveHint: (code) =>
			({
				STATE_CHANGED: ": changed since inspection; kept in place.",
				MOVE_FAILED: ": move failed; kept in place (no copy fallback).",
				RECORD_FAILED:
					": the record could not be written; kept in place and nothing was moved.",
				RECORD_FAILED_AFTER_MOVE:
					": moved, but the record was not finalized; run trash list, then restore <ID> if needed.",
			})[code as "STATE_CHANGED"] ?? "",
		kept: (path, status, codes) => `Kept ${path}: ${status} ${codes}`,
		wouldMove: (path, destination, bytes) =>
			`Would move ${path} to ${destination} (logical bytes, estimate: ${bytes ?? "unknown"}).`,
		prompt: (path, destination) => `Move ${path} to ${destination}?`,
		skipped: (path) => `Skipped ${path}.`,
		moved: (path, id, destination) => `Moved ${path}: ${id} -> ${destination}`,
		stopped:
			"Stopped: the state store is not reliable, so remaining repositories were not moved. Run trash list.",
		stateStore: (path) => `State store: ${path}`,
		dryRunSummary: (would, kept) =>
			`Dry run: nothing was moved. Would move ${would}; kept ${kept}.`,
		summary: (moved, skipped, kept, failed) =>
			`Moved ${moved}; skipped ${skipped}; kept ${kept}; failed ${failed}.`,
		review:
			"Review with: trash list. Put a repository back with: restore <ID>.",
		empty: "No repositories.",
		incomplete:
			"CLEAN_INCOMPLETE: some repositories could not be diagnosed or moved; see the output.",
	},
	ja: {
		moveNotice:
			"同一ファイルシステム内の移動ではディスク容量は空きません。ロックはエディタ・Git・その他の外部書き込みを止めないので、使用中のリポジトリには実行しないでください。",
		moveHint: (code) =>
			({
				STATE_CHANGED: ": 検査後に状態が変わったため、そのまま残しました。",
				MOVE_FAILED:
					": 移動に失敗したため、そのまま残しました（コピーへのフォールバックなし）。",
				RECORD_FAILED:
					": 記録を書き込めなかったため、そのまま残し、何も移動していません。",
				RECORD_FAILED_AFTER_MOVE:
					": 移動しましたが記録を確定できませんでした。trash list を確認し、必要なら restore <ID> を実行してください。",
			})[code as "STATE_CHANGED"] ?? "",
		kept: (path, status, codes) => `残す ${path}: ${status} ${codes}`,
		wouldMove: (path, destination, bytes) =>
			`移動予定 ${path} -> ${destination} (論理サイズ概算: ${bytes ?? "不明"} バイト)`,
		prompt: (path, destination) => `${path} を ${destination} へ移動しますか?`,
		skipped: (path) => `スキップ ${path}`,
		moved: (path, id, destination) =>
			`移動済み ${path}: ${id} -> ${destination}`,
		stopped:
			"中断: 状態領域が信頼できないため、残りのリポジトリは移動していません。trash list を実行してください。",
		stateStore: (path) => `状態領域: ${path}`,
		dryRunSummary: (would, kept) =>
			`ドライラン: 何も移動していません。移動予定 ${would} 件; 残す ${kept} 件。`,
		summary: (moved, skipped, kept, failed) =>
			`移動 ${moved} 件; スキップ ${skipped} 件; 残す ${kept} 件; 失敗 ${failed} 件。`,
		review: "確認: trash list。元に戻す: restore <ID>。",
		empty: "対象のリポジトリはありません。",
		incomplete:
			"CLEAN_INCOMPLETE: 診断または移動できなかったリポジトリがあります。出力を確認してください。",
	},
} as const satisfies Record<Locale, CleanText>;

export const cleanText = (locale: Locale): CleanText => cleanTexts[locale];

interface TrashEntryView {
	id: string;
	status: string;
	original?: string;
	destination?: string;
	created_at?: string;
	updated_at?: string;
	recorded?: string | boolean;
	original_present?: boolean;
	destination_present?: boolean;
}

interface RestoreText {
	restoreHint: (code: string) => string | undefined;
	storeUnreadable: (code: string, restoring: boolean) => string;
	entry: (entry: TrashEntryView, quote: (value: unknown) => string) => string;
	trashEmpty: string;
	entryCount: (entries: number, attention: number) => string;
	unstable: string;
	recoveryRequired: string;
	unknownId: (id: string) => string;
	alreadyRestored: (id: string, original: string, updated: string) => string;
	notRestorable: (id: string, status: string) => string;
	prompt: (id: string, destination: string, original: string) => string;
	skipped: string;
	restoreFailed: (code: string, id: string) => string;
	restored: (id: string, destination: string, original: string) => string;
}

const manualEn =
	"Nothing was changed. See the README (退避・復元と復旧) for manual recovery.";
const manualJa =
	"何も変更していません。手動での復旧は README の「退避・復元と復旧」を参照してください。";

const guidanceEn = (status: string, manual: string, id: string) =>
	({
		not_moved: "Not moved: the original is still in place.",
		recoverable: `Moved but not finalized: restore ${id} can put it back.`,
		recovery_required: `Ambiguous state: do not restore automatically. ${manual}`,
		invalid_record: `The record is unreadable or fails verification. ${manual}`,
		orphan_entry: `The entry has no record. ${manual}`,
	})[status as "not_moved"];

const guidanceJa = (status: string, manual: string, id: string) =>
	({
		not_moved: "未移動: 元のリポジトリはそのまま残っています。",
		recoverable: `移動済みですが未確定です: restore ${id} で元に戻せます。`,
		recovery_required: `状態が曖昧です: 自動で restore しないでください。${manual}`,
		invalid_record: `記録を読めないか、検証に失敗しました。${manual}`,
		orphan_entry: `このエントリには記録がありません。${manual}`,
	})[status as "not_moved"];

const restoreTexts = {
	en: {
		restoreHint: (code) =>
			({
				LOCK_HELD:
					": another clean or restore is running; nothing was changed. Retry later.",
				STORE_UNSAFE: `: the state store has unsafe ownership, permissions or symlinks. ${manualEn}`,
				UNRESTORABLE: `: the destination exists, its parent is missing, or the entry needs manual recovery. ${manualEn}`,
				RECORD_FAILED:
					": the record could not be written before the move; nothing was moved. Run trash list.",
				MOVE_FAILED:
					": the move failed after the record was updated; the data stays in the trash. Run trash list; the entry can be restored again.",
				RECORD_FAILED_AFTER_MOVE:
					": restored, but the record was not finalized. Run trash list.",
			})[code as "LOCK_HELD"],
		storeUnreadable: (code, restoring) =>
			restoring
				? `${code}: the state store could not be read safely. ${manualEn}`
				: `${code}: the state store could not be read safely, so the history is unknown. ${manualEn}`,
		entry: (entry, quote) => {
			const presence = (value?: boolean) => (value ? "present" : "absent");
			const guidance = guidanceEn(entry.status, manualEn, entry.id);
			return [
				`${entry.id} ${entry.status}`,
				...(entry.recorded
					? [
							`  Original: ${quote(entry.original)}`,
							`  Destination: ${quote(entry.destination)}`,
							`  Created: ${entry.created_at}; updated: ${entry.updated_at}`,
							`  Record: ${entry.recorded}; check: ${entry.status}; original path ${presence(entry.original_present)}; destination ${presence(entry.destination_present)}`,
						]
					: [`  Record: unreadable or missing; check: ${entry.status}`]),
				...(guidance ? [`  ${guidance}`] : []),
			].join("\n");
		},
		trashEmpty: "Trash is empty.",
		entryCount: (entries, attention) =>
			`${entries} entries; ${attention} need attention.`,
		unstable:
			"The store changed while it was being listed, so the result is not reliable. Run trash list again.",
		recoveryRequired:
			"RECOVERY_REQUIRED: some entries are unresolved or unverifiable; see the guidance above.",
		unknownId: (id) =>
			`UNKNOWN_ID ${id}: no such entry; run trash list. Nothing was changed.`,
		alreadyRestored: (id, original, updated) =>
			`ALREADY_RESTORED ${id}: restored to ${original} (last updated ${updated}); nothing was changed.`,
		notRestorable: (id, status) =>
			`NOT_RESTORABLE ${id} ${status}: ${manualEn}`,
		prompt: (id, destination, original) =>
			`Restore ${id} from ${destination} to ${original}?`,
		skipped: "Skipped.",
		restoreFailed: (code, id) =>
			`${code} ${id}: restore did not complete; run trash list to see the current state.`,
		restored: (id, destination, original) =>
			`Restored ${id} from ${destination} to ${original}.`,
	},
	ja: {
		restoreHint: (code) =>
			({
				LOCK_HELD:
					": 別の clean または restore が実行中です。何も変更していません。後で再試行してください。",
				STORE_UNSAFE: `: 状態領域の所有者・権限・symlink が安全ではありません。${manualJa}`,
				UNRESTORABLE: `: 復元先が既に存在するか、親ディレクトリがないか、手動での復旧が必要なエントリです。${manualJa}`,
				RECORD_FAILED:
					": 移動前に記録を書き込めなかったため、何も移動していません。trash list を実行してください。",
				MOVE_FAILED:
					": 記録の更新後に移動が失敗しました。データはごみ箱に残っています。trash list を実行してください。再度 restore できます。",
				RECORD_FAILED_AFTER_MOVE:
					": 復元しましたが記録を確定できませんでした。trash list を実行してください。",
			})[code as "LOCK_HELD"],
		storeUnreadable: (code, restoring) =>
			restoring
				? `${code}: 状態領域を安全に読み取れませんでした。${manualJa}`
				: `${code}: 状態領域を安全に読み取れなかったため、履歴は不明です。${manualJa}`,
		entry: (entry, quote) => {
			const presence = (value?: boolean) => (value ? "あり" : "なし");
			const guidance = guidanceJa(entry.status, manualJa, entry.id);
			return [
				`${entry.id} ${entry.status}`,
				...(entry.recorded
					? [
							`  元のパス: ${quote(entry.original)}`,
							`  退避先: ${quote(entry.destination)}`,
							`  作成: ${entry.created_at}; 更新: ${entry.updated_at}`,
							`  記録: ${entry.recorded}; 確認: ${entry.status}; 元のパス ${presence(entry.original_present)}; 退避先 ${presence(entry.destination_present)}`,
						]
					: [`  記録: 読めないか存在しません; 確認: ${entry.status}`]),
				...(guidance ? [`  ${guidance}`] : []),
			].join("\n");
		},
		trashEmpty: "ごみ箱は空です。",
		entryCount: (entries, attention) =>
			`${entries} 件; 要対応 ${attention} 件。`,
		unstable:
			"一覧の取得中に状態領域が変化したため、結果は信頼できません。もう一度 trash list を実行してください。",
		recoveryRequired:
			"RECOVERY_REQUIRED: 未解決または検証できないエントリがあります。上の案内を確認してください。",
		unknownId: (id) =>
			`UNKNOWN_ID ${id}: 該当するエントリがありません。trash list を実行してください。何も変更していません。`,
		alreadyRestored: (id, original, updated) =>
			`ALREADY_RESTORED ${id}: ${original} に復元済みです (最終更新 ${updated})。何も変更していません。`,
		notRestorable: (id, status) =>
			`NOT_RESTORABLE ${id} ${status}: ${manualJa}`,
		prompt: (id, destination, original) =>
			`${id} を ${destination} から ${original} へ復元しますか?`,
		skipped: "スキップしました。",
		restoreFailed: (code, id) =>
			`${code} ${id}: 復元が完了しませんでした。trash list で現在の状態を確認してください。`,
		restored: (id, destination, original) =>
			`${id} を ${destination} から ${original} へ復元しました。`,
	},
} as const satisfies Record<Locale, RestoreText>;

export const restoreText = (locale: Locale): RestoreText =>
	restoreTexts[locale];
