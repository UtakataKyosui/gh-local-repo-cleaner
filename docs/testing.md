# 要件と検証の対応

通常テストは bun:test、実 Git、一時 bare remote、一時ディレクトリを使う。
HOME / XDG / Git global / system 設定を隔離し、author identity は fixture 内だけに設定する。
ghq は PATH 上の偽 executable で再現する。public remote、ユーザーの ghq root、
実 GitHub 認証、ユーザーのリポジトリの移動・削除は使わない。

## Issue #3 / #5 / #7: 探索・オンライン検証・設定とメタデータ

- `src/core/discovery.test.ts`: 偽ghq executableで空一覧、複数・入れ子ルート、正規化、実体重複、末尾空白、日本語、曖昧な管理名、コマンド失敗を検証。spawn/timeoutはrunner境界で故障注入。
- `src/core/core.test.ts`: ローカルbare remoteで削除・force push、非checkoutブランチの未保全件数、detached HEAD、複数remoteの和集合と部分失敗、独自refsの除外、削除upstream、未対応transport、取得中のremote変更と元snapshot不変を検証。
- `src/core/configuration.test.ts`: version/キー/ルールの厳密検証、globの文字クラス・エスケープ・スラッシュ境界、既定/明示ファイルの不在、容量のGit/ignored・hardlink・symlink循環・読み取り失敗を検証。権限テストはroot実行時のみskip。
- `src/commands/integration.test.ts`: 設定変更後の移動停止、ignored内の入れ子リポジトリ保護、全ブランチtipの最大日時、空リポジトリのnull、メタデータ取得失敗時のSAFE維持とJSONエラー表現を検証。
- `src/commands/commands.test.ts`: SAFE容量概算・欠損件数とフィルター前の集計を検証。
- `stale remote-tracking history without reflogs is diagnosed and never evacuated`（integration）: remoteブランチとローカルブランチを削除しreflogを失効させても、tracking refだけに残る固有履歴をDIRTYとして検出し、cleanで移動しないことを実Gitで検証。現在のremoteに同じ履歴を保全するとSAFEに戻ることも確認。

## Issue #4: ローカル保護判定

| 要件 | テスト名（src/core/core.test.ts） | OS |
| --- | --- | --- |
| FR-03 staged / unstaged / untracked / ignored | staged and unstaged changes are detected; NUL output detects ignored and untracked names with whitespace and newlines | macOS / Linux |
| FR-03/06 stash / tag / detached / worktree | stash, tags, detached HEAD and extra worktrees are preserved | macOS / Linux |
| FR-03 submodule / gitlink / bare | gitlinks and bare repositories cannot be treated as ordinary repositories; protects submodule file; protects module metadata | macOS / Linux |
| FR-03 partial / sparse / flags / replace / alternates | protects partial; protects sparse; protects assume unchanged; protects skip worktree; protects replace refs; protects alternates | macOS / Linux |
| FR-03 進行中操作 | protects merge; protects operation marker（rebase-apply / rebase-merge / CHERRY_PICK_HEAD / REVERT_HEAD / BISECT_LOG / sequencer） | macOS / Linux |
| FR-03 unborn / shallow / 外部 gitdir | unborn, shallow and separate gitdir layouts never become SAFE | macOS / Linux |
| FR-03/06 reflog / annotated tag / 孤立 blob | annotated tags, reflog-only history and orphan blobs require object-level preservation | macOS / Linux |
| FR-07/16 全理由 / 優先順位 / 検査失敗 | classification keeps all reasons, deduplicates and applies safety priority; dirty plus ignored and corrupt index retains all reasons with UNKNOWN priority; typed process failures become UNKNOWN without exposing command output | macOS / Linux |
| FR-09 snapshot / 変更検出 | verified clone is SAFE and immutable snapshot is excluded from diagnosis JSON; a concurrent write invalidates the inspection snapshot | macOS / Linux |
| NFR-06 特殊名 / 不正出力 | porcelain parses rename source separately and rejects incomplete records | macOS / Linux |

## Issue #9: 共通 CLI

| 要件 | テスト（src/commands/commands.test.ts、src/core/runner.test.ts） | OS |
| --- | --- | --- |
| FR-07/08 引数・旧形式・不正オプション | normalizes（引数表）; rejects invalid arguments（不正組合せ表） | macOS / Linux |
| FR-10 JSON / filter / snapshot 非公開 | JSON contract excludes snapshots and filters display without hiding UNKNOWN exit and totals | macOS / Linux |
| FR-14 stdout / stderr / 終了値 | Crust dispatches normalized argv via official Effect service and separates output | macOS / Linux |
| FR-14 help / version / 未接続拒否 | unconnected services fail explicitly and help/version never acquire a service | macOS / Linux |
| FR-08 非 TTY / 確認 / EOF | confirmation accepts only explicit y/yes, refuses EOF and enforces TTY | macOS / Linux |
| NFR-06 timeout / literal argv / 環境隔離 | runner reports command exit and enforces timeout; runner isolates Git selection/config injection and preserves literal argv | macOS / Linux |
| NFR-06 出力上限 / UTF-8 / spawn / cancel | runner classifies output limits, invalid UTF-8, spawn failures and cancellation; cancellation propagates through Crust and returns 130 | macOS / Linux |
| Effect ライフサイクル | official adapter releases the core layer on success / failure / cancel with its Exit（src/runtime.test.ts） | macOS / Linux |

## Issue #6: 退避・復元と操作記録

| 要件 | テスト | OS |
| --- | --- | --- |
| 排他ロック・上書きしない rename | `src/core/platform.test.ts`: 保持中の即時失敗、SIGKILL 後の解放、既存の空ディレクトリ・ファイル・不在元の拒否 | macOS / Linux |
| 往復保持・保存先と権限 | `src/core/trash.test.ts`: round trip keeps .git, settings, modes and symlinks in private storage | macOS / Linux |
| 確認後の変化・再検査 | trash.test.ts: a failed revalidation or a changed snapshot keeps the repository and creates no entry | macOS / Linux |
| 自身・親・管理ルート・退避領域の保護 | trash.test.ts: the working directory, its parents, the management root and the store are never moved | macOS / Linux |
| 記録失敗・rename 失敗（EXDEV / EACCES / 衝突） | trash.test.ts: record write failure before the move...; rename failures (EXDEV, EACCES, collision) keep the source and never fall back to copying | macOS / Linux |
| 移動後の記録失敗・途中終了の識別 | trash.test.ts: a failed move record update reports the id...; prepared records reconcile...; an interrupted restore is recorded as restoring and can be resumed。integration.test.ts の別プロセス SIGKILL | macOS / Linux |
| symlink 差し替え・確認後の変更・作業ディレクトリ保護 | trash.test.ts: a symlink swapped in for the repository after inspection is never followed or moved; a failed revalidation or a changed snapshot keeps the repository...（ファイル追加、ignored 設定・ignored ファイル、HEAD 更新）; a repository containing the working directory is never moved。integration.test.ts: clean run from inside a SAFE repository keeps that repository | macOS / Linux |
| 強制終了の 3 時点（rename 前・rename 後・戻り後） | trash.test.ts: a process killed before the rename, after it, or after the move returns leaves an identifiable state（`not_moved` / `recoverable` / `moved`、ロック解放も確認） | macOS / Linux |
| 要手動復旧 entry の restore | integration.test.ts: restore of an entry that needs manual recovery names its state and changes nothing | macOS / Linux |
| 復元先衝突・親不在・上書き禁止 | trash.test.ts: restore refuses any existing destination and a missing parent, and never overwrites。integration.test.ts: concurrent restore processes never overwrite an existing destination | macOS / Linux |
| 改ざん・`../../` ID・破損 record の隔離 | trash.test.ts: tampered records, changed payloads and traversal IDs are rejected; one corrupt entry does not hide the others... | macOS / Linux |
| 権限不正・symlink・同時実行 | trash.test.ts: unsafe storage permissions and a second concurrent session fail without being used。integration.test.ts: an unsafe state directory or a held lock stops clean before any move | macOS / Linux |
| 既定 state root | integration.test.ts: default state root follows an absolute XDG_STATE_HOME and ignores a relative one | macOS / Linux |
| 配布バイナリでの FFI | `scripts/verify-distribution.sh`: ビルド済みバイナリで clean → trash list → restore | macOS / Linux |

## Issue #8: 統合・配布

| ID / 要件 | テスト（src/commands/integration.test.ts、指定時 core.test.ts） | OS |
| --- | --- | --- |
| E2E-01 / 読み取り専用 | E2E-01 clean clone scan is SAFE, read-only and creates no state | macOS / Linux |
| E2E-02/03 / 4 状態、継続、SAFE のみ移動 | E2E-02/03 mixed batch continues, clean --yes moves SAFE only | macOS / Linux |
| E2E-04 / 直前再検査 | E2E-04 state changed during approval is kept | macOS / Linux |
| E2E-05 / remote 削除・force push | fresh remote refs override stale tracking refs after deletion and force push（core.test.ts） | macOS / Linux |
| E2E-06 / stash / tag / reflog / blob | 上記 #4 の保護テスト | macOS / Linux |
| E2E-07 / dry-run・非 TTY | E2E-07 dry-run skips confirmation and state; non-TTY mutation requires --yes | macOS / Linux |
| E2E-08/10 / 復元・衝突・改ざん | E2E-08/10 clean -> trash list -> restore retains data and rejects collisions/tampering | macOS / Linux |
| E2E-09 / 記録失敗・プロセス強制終了 | E2E-09 record failure after rename exposes recovery candidate without losing data; separate process death immediately after rename leaves a recoverable pending record | macOS / Linux |
| E2E-11 / 表示 filter の集計・終了値 | E2E-11 filtered JSON retains UNKNOWN in summary and exit status | macOS / Linux |
| E2E-12 / ローカル保全先依存 | E2E-12 local remote inside target set protects dependent repositories | macOS / Linux |
| E2E-12 / insteadOf・symlink・file URL | rewritten path / symlink / file-url remote protects both dependency endpoints from clean --yes | macOS / Linux |
| FR-04/05 / 相対 remote | relative local remote is verified from the repository rather than cleaner cwd | macOS / Linux |
| FR-09 / 依存関係が未確認の保護 | unresolved remote dependency graph prevents moving otherwise SAFE targets | macOS / Linux |
| FR-01/02 / ghq 複数ルート・欠損・不正出力 | ghq executable supports multiple roots, Japanese paths, duplicates and per-item failures | macOS / Linux |
| FR-08/12 / 除外・symlink・EXDEV | exclusion configuration, symlink escapes and injected EXDEV never move source | macOS / Linux |
| NFR-08 / 同時 clean / restore | separate clean processes serialize under the store lock; concurrent restore processes never overwrite an existing destination | macOS / Linux |
| NFR-08 / 権限・記録失敗 | injected permission and pending-record failures preserve the source | macOS / Linux |
| FR-09 / 外部 Git 設定の変更 | global Git configuration changes after approval invalidate the snapshot | macOS / Linux |
| 配布 / クリーン導入 | scripts/verify-distribution.sh: 隔離 gh extension install、Bun のない PATH、help / SAFE scan / trash list | macOS arm64 / Linux arm64、Linux x64（CI 定義） |

## 実行証跡と制限

2026-10-24: Docker の native Linux arm64 / Bun 1.4.4 で、
初回実装（`102546f`）の **88 tests / 201 assertions** の一括実行に成功した。macOS arm64 は全86件の成功後、
追加・変更したテストと不具合修正箇所を絞って再実行し、現行88件に対応する検証を完了した。
両OSで型チェックとホストバイナリ生成を検証した。
macOS で Biome・Fallow・actionlint・bash 構文・git diff の検査に成功した。
隔離した gh extension の導入・基本実行は両OSで検証し、最終の結果は PR 本文にも記録する。

Linux x64 の QEMU エミュレーションでは Bun がテスト開始前に MemoryExhaustion で異常終了した。
これはテスト成功に数えない。先行の GitHub hosted CI はアカウントの支払い・利用上限で runner が開始しなかった。
その後、実装コミット `102546f` の [CI run 40094131443](https://github.com/UtakataKyosui/gh-local-repo-cleaner/actions/runs/40094131443) は
Linux x64 / Linux arm64 / macOS arm64 の全環境でテスト・ビルド・隔離した拡張導入・配布検証・成果物保存に成功した。
品質チェックも成功している。検証結果だけの文書更新には `[skip ci]` を付けて同じコードの再検証を避ける。
テストはOS/archごとに1回だけ実行する。build・package・配布 smoke から bun test は呼ばない。
すでにCIで成功した同一変更のテストをローカルで重複実行しない。

PR レビュー対応では上記の remote URL 回帰テストを5件追加した。
追加・影響箇所をローカルで検証し、更新コードの3環境の CI 結果は PR 本文に記録する。

故障注入は TrashStore の move / beforeSave 境界で行い、実際の chmod 失敗に依存しない。
外部プロセスとの全競合を排除する保証や、未対応 OS / arch の動作確認は含めない。
Release 公開・npm publish・実リポジトリでの運用検証は実施しない。
