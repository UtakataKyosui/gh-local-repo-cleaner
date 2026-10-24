# gh-local-repo-cleaner

ghq 管理下、または指定ディレクトリ直下の Git リポジトリを診断し、
保全を確認できたものだけアプリ専用領域へ退避する GitHub CLI 拡張です。
完全削除、commit、push、gc、prune、reflog expire は実行しません。

## 必要環境と開発

開発・ビルドは Bun **1.4.4**、Git、配布検証には GitHub CLI が必要です。
実行時には Git、ghq モードには ghq が必要です。単体バイナリは Bun を内蔵します。
TypeScript **7.0.2**、Crust **0.5.6**、公式 Effect adapter **0.2.3**、
Effect **4.0.6** を `package.json` と `bun.lock` で固定しています。

```sh
bun install --frozen-lockfile
bun run dev --help
bun run check:types
bun test
bun run check                  # Biome / Fallow / types / tests
bun run fix                    # Biome の安全な修正
bun run build --target host
```

Biome は整形・import・推奨 Lint、Fallow は未使用コード・依存・構造を検査します。
`bun.lock` を更新するときは依存変更と一緒にレビューし、CI は frozen install を使います。
本番依存の追加は事前確認が必要です。

## コマンド

```sh
gh local-repo-cleaner                         # ghq 全件の scan
gh local-repo-cleaner scan --ghq
gh local-repo-cleaner scan ~/projects         # 直下だけ、再帰探索しない
gh local-repo-cleaner ~/projects              # scan の省略形
gh local-repo-cleaner list ~/projects --status safe --json
gh local-repo-cleaner inspect ./project
gh local-repo-cleaner inspect github.com/owner/repo
gh local-repo-cleaner clean ~/projects --dry-run
gh local-repo-cleaner clean ~/projects        # 各 SAFE に確認して退避
gh local-repo-cleaner clean ~/projects --yes
gh local-repo-cleaner ~/projects --delete --yes  # clean と同一経路
gh local-repo-cleaner trash list
gh local-repo-cleaner restore <id>
```

`scan` / `list` / `inspect` は読み取り専用です。リモート検証の fetch は
一時的な隔離 bare ストアにだけ書き込み、元リポジトリの refs や index を更新しません。
`clean` が明示的な退避操作です。先に `--dry-run` で対象を確認してください。
`--dry-run` は確認入力・状態領域・操作記録を作りません。
実移動の非 TTY 実行には `--yes` が必要ですが、検査や保護は省略しません。
承認は `y` / `yes`（大文字小文字不問）のみで、空入力・EOF は拒否です。
予約語と同名のディレクトリは `./scan` のように指定します。

`inspect` の管理名は ghq 一覧の完全一致です。絶対パス、`./`、`../` 始まりは
個別パスとして扱います。`--ghq` とディレクトリ指定の併用はできません。

## 状態と手動対処

| 状態 | 意味・対処 |
| --- | --- |
| SAFE | 必須検査に成功し、現在のリモート refs から対象オブジェクトを保全確認済み |
| DIRTY | staged / unstaged / 未追跡、未保全コミット。手動で保存・追跡・commit・push を確認 |
| PROTECTED | ignored、stash、未保全タグ・reflog・オブジェクト、除外、特殊構成。別途保存・構成確認 |
| UNKNOWN | Git / ghq / 認証 / ネットワーク / 解析 / 状態変化などで確認不能。原因を解消して再診断 |

理由は全件保持し、集約優先順位は `UNKNOWN > PROTECTED > DIRTY > SAFE` です。
ローカルタグは同名リモートタグの object ID 一致を要求し、annotated tag 自体も保護します。
HEAD・全 refs・reflog と `fsck --unreachable --no-reflogs` のオブジェクトを検査し、
古い remote-tracking refs や ahead 数だけを安全の証拠にしません。
リモート refs が検証中に変わった場合も確認不能とします。

追加・linked worktree、submodule、bare、shallow、partial / sparse clone、
外部 gitdir / common dir / alternates、隠れた index フラグ、進行中操作、
replace refs / grafts / 特殊 refs、unborn HEAD は退避しません。
診断対象内にローカル remote がある場合、その依存元・保全先の自動退避を保護します。
remote は Git の `remote get-url` で `url.*.insteadOf` 展開後の URL を取得し、
相対ローカルパスは検査対象リポジトリを基準に解決します。symlink と file URL も
実パスで依存関係を照合します。既存リポジトリの remote を解決できず依存関係を
確認できない場合は、対象群を UNKNOWN として自動退避しません。

## 除外と出力

`scan` / `list` / `inspect` / `clean` は既定で
`$XDG_CONFIG_HOME/gh-local-repo-cleaner/config.json` を読みます。
`XDG_CONFIG_HOME` 未指定時は `~/.config` を使い、`--config PATH` でファイルを置換できます。
既定ファイルの不在のみ空設定です。明示ファイルの不在、読み取り失敗、不正JSON、未知キー・version・不正パターンは終了2です。

```json
{
  "version": 1,
  "exclude": [
    {"kind": "name", "pattern": "github.com/company/*"},
    {"kind": "path", "value": "/absolute/path/to/repository"}
  ]
}
```

`name` は管理名全体へのglobです。`*` は `/` 以外の0文字以上、`?` は1文字、
`[abc]` / `[a-z]` / `[^abc]` は文字クラス（`/` には一致しません）、
バックスラッシュは次の文字のエスケープです。`**` に再帰の意味はありません。
壊れた文字クラス・末尾エスケープは拒否します。
`path` は正規化した絶対パスへの完全一致です。相対パス・`~`・環境変数の展開は行いません。
directoryモードの管理名は指定ルート直下の相対名です。JSONの `source` / `root` で識別できます。
一致は `PROTECTED / EXCLUDED_BY_CONFIG` と0始まりの `rule_index` を返し、`--yes` でも解除しません。
cleanは移動直前に設定を再読込し、内容変更・エラー時は停止します。

`--json` は `scan` / `list` / `inspect` のみ対応します。stdout は単一の JSON
オブジェクトで `schema_version: 1`、`repositories`、`summary`、`errors` を持ちます。
各 repository は source / root / path / name / status / reasons / checked_at / metadata を持ち、
理由は code / status / message / action を含みます。内部 snapshot は出力しません。
パス順・理由 code 順に並べ、診断は stderr に分離します。
`list --status` の summary と終了値はフィルター前の全件から算出します。

容量は `.git` と ignored を含む論理サイズの概算です。symlink は辿らず、
通常ファイルのみを数え、hardlinkは各パスで加算します。
取得不能は `size_bytes: null` と `metadata_errors` で表し、部分値を総量として返しません。
SAFEの既知サイズ合計 `safe_size_bytes_estimate` と欠損数 `safe_size_unknown_count` をJSONのsummaryに出します。
同一ファイルシステム内の退避は空き容量を増やしません。
`last_commit_at` は全ローカルブランチtipとHEADのcommitter timestampの最大値（UTC RFC3339）です。
コミットなし・取得不能は `null`。ファイル更新日時や作業の有無は表さず、メタデータのみの取得失敗は安全判定を変更しません。

オンライン検証は隔離した一時bareストアで各remoteの現在のheads/tagsを取得し、取得前後のrefsと照合します。
独自refs・古いtracking refs・upstream設定だけは保全の証拠にしません。
各ブランチの未保全コミット数は理由の `branch` / `commit_count` に出します。
remote変更は `REMOTE_CHANGED_DURING_SCAN`、検証失敗は `REMOTE_VERIFICATION_FAILED` です。
許可transportはローカルパス・file・https・http・ssh（scp形式を含む）・gitに固定し、helper/extは拒否します。
認証対話を禁止しtimeoutを適用します。`checked_at` は検証時点であり、その後のremote変更は保証しません。

終了値は `0`=完了（DIRTY / PROTECTED / 拒否を含む）、`1`=UNKNOWN または操作失敗、
`2`=引数・設定エラー、`130`=キャンセルです。
外部プロセスは shell を使わず argv 配列で実行し、Git は既定60秒、ghq は30秒、
stdout は16 MiBを上限とします。生の stderr や認証 URL をエラー表示しません。
外部の `GIT_DIR` / `GIT_WORK_TREE` / index / object / 設定注入環境は持ち込みません。

## 退避・復元と復旧

退避先は `${XDG_DATA_HOME:-$HOME/.local/share}/gh-local-repo-cleaner` です。
`clean` / `trash list` / `restore` には絶対パスの `--state-dir` を指定できます。
専用ディレクトリは0700、鍵と記録は0600です。元リポジトリ全体を rename し、
クロスデバイス移動・権限エラー時にコピー後削除へ切り替えません。

承認後に再診断とパス・内容・実体の snapshot 照合を行い、変化した対象は保持します。
移動前に pending 記録を永続化し、移動後に moved、復元後に restored を記録します。
記録には ID、元パス、管理ルート、日時、結果と照合情報を保持し、HMAC で改ざんを検出します。
復元先の衝突、記録・payload の改変、領域外パスは操作しません。
store のロックで clean / restore を直列化し、移動と記録の区間はキャンセルから保護します。

強制終了後の `trash list` は `recovery-required` / `invalid-record` / `orphan-payload` を
表示して終了1にします。自動削除や推測したパスへの復元は行いません。
他のプロセスが動いていないことを確認し、store 全体（key、記録、ID ディレクトリ）を
別途保全してください。pending 記録の元パスと ID の実体を照合し、衝突しない場所へ
手動で保全してから調査します。残った `.lock` は動作中プロセスがないことを確認した場合のみ
空ディレクトリとして除去します。整合性を確認できるまで clean / restore を再開しないでください。

SAFE は検査時点の既知条件の成立です。外部プロセスとの書き込み競合を完全には排除できません。
作業中のリポジトリには実行せず、別プロセスが復元先や store を操作しない状態で使ってください。
全ファイルを内容照合するため、大きいリポジトリの検査には時間がかかります。

## ビルドと配布

[Crust の build / distribution](https://crustjs.com/docs/guide/build-and-distribution/) に従い、
`bun run build --target host` でランタイム内蔵バイナリと manifest を `.crust/` に生成します。
`bun run start` は Bun で npm 向け launcher を起動します。npm から直接 launcher を実行する場合は Node.js が必要です。
直接実行するプラットフォーム別バイナリには Node.js / Bun / Deno の追加導入は不要です。

```sh
bun run build --target host
bash scripts/verify-distribution.sh darwin-arm64  # Linux x64 は linux-x64
```

検証スクリプトは一時 HOME / XDG / gh 設定で `gh extension install .` を実行し、
Bun のない PATH で help、実 Git の scan、不在 trash の読み取りを確認します。
ユーザーの拡張・認証設定は変更しません。CI は品質チェックを1回、テストをOS/archごとに1回、
その後に build / 配布確認 / package を行い、build からテストを再実行しません。
feature branch の push と PR の二重起動を避け、同じ ref の古い実行を取り消します。

CI artifacts の `distribution/` には raw binary、全隣接 asset 入り tar.gz、
`SHA256SUMS` を格納し、manifest も保存します。raw binary 名は
`gh-local-repo-cleaner-linux-amd64` / `gh-local-repo-cleaner-linux-arm64` / `gh-local-repo-cleaner-darwin-arm64` です。
[GitHub の拡張仕様](https://docs.github.com/en/github-cli/github-cli/creating-github-cli-extensions)
に従い、将来の Release に添付する場合は OS-ARCH の名前を使います。
現在はリリース・npm publish を自動実行しません。

artifact を展開してローカル導入する場合は、checksum を確認し、
`gh-local-repo-cleaner` ディレクトリに tar を展開して `git init` した後、
そのディレクトリで `gh extension install .` を実行します。
CI の配布対象は Linux x64 / Linux arm64 / macOS arm64 です。3環境とも
テスト・ビルド・拡張の導入・基本実行・成果物保存まで CI で検証済みです。
他の OS / arch は配布検証対象外です。

検査・Git runner・設定・snapshot・退避は `src/core/`、共通型は `src/model/`、
CLI 正規化・出力・サービス接続は `src/commands/`、外部プロセス境界は `src/executil/` に分離しています。
[公式 @crustjs/effect](https://crustjs.com/docs/modules/effect/) の `layer` / `handler` で接続し、
独自 ManagedRuntime は使用しません。検証の実行状況と要件対応は [docs/testing.md](docs/testing.md) を参照してください。
