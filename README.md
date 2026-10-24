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
gh local-repo-cleaner scan --group-by language # 言語ごとに見出しを付けて表示
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
存在しない、またはディレクトリでない DIR は引数エラー（終了2）、
存在しても読めない DIR は列挙失敗（終了1）です。

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

テキスト出力は stdout が TTY のとき状態ごとに色付けします（SAFE=緑、DIRTY=黄、PROTECTED=赤、UNKNOWN=マゼンタ）。`NO_COLOR` で無効化、`FORCE_COLOR` で強制できます。`--json` は常に無色です。

stderr が TTY のとき、診断中は進捗ゲージ（`Scanning ████░░░ 3/28`）を stderr に表示し、完了時に消します。stdout と JSON には混ざりません。

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

`scan` / `list` の `--group-by language` は、リポジトリを主言語ごとにまとめて表示します
（言語名の昇順、判定不能の `Other` は末尾）。見出しには表示対象の状態別件数を出します。
`--status` で絞った場合は絞り込み後の件数です。JSON は `--group-by` の有無にかかわらず
`metadata.language`（判定不能は `null`）を持ち、指定時は `summary.by_language` を追加します。
主言語はリポジトリ直下のマーカーファイルの存在だけで決め、内容は読まず、symlink は辿りません。
複数あるときは次の表で上にあるものを採用します。言語は表示用で、安全判定には影響しません。
マーカーの確認に失敗したときは `metadata_errors` に `LANGUAGE_UNAVAILABLE` を出し、`language` は `null` です。

| 優先 | マーカー | 言語 |
|---|---|---|
| 1 | `tsconfig.json` | TypeScript |
| 2 | `package.json` | JavaScript |
| 3 | `Cargo.toml` | Rust |
| 4 | `go.mod` | Go |
| 5 | `pyproject.toml` / `requirements.txt` / `setup.py` | Python |
| 6 | `Gemfile` | Ruby |
| 7 | `composer.json` | PHP |
| 8 | `pom.xml` / `build.gradle` | Java |
| 9 | `build.gradle.kts` | Kotlin |
| 10 | `Package.swift` | Swift |
| 11 | `mix.exs` | Elixir |
| 12 | `CMakeLists.txt` | C/C++ |

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
`2`=引数・設定エラー、`130`=キャンセル（Ctrl-C）です。
移動・復元の実行中に Ctrl-C を受けた場合は、その1件の移動と記録更新を完了して整合させてから
130 で終了し、以降の対象は処理しません。
外部プロセスは shell を使わず argv 配列で実行し、Git は既定60秒、ghq は30秒、
stdout は16 MiBを上限とします。生の stderr や認証 URL をエラー表示しません。
外部の `GIT_DIR` / `GIT_WORK_TREE` / index / object / 設定注入環境は持ち込みません。

## 退避・復元と復旧

退避先（state root）は、絶対パスの `XDG_STATE_HOME` があればその下の
`gh-local-repo-cleaner`、なければ `~/.local/state/gh-local-repo-cleaner` です。
`clean` / `trash list` / `restore` には絶対パスの `--state-dir` を指定できます。
元リポジトリと包含関係にある場所は拒否します。

```text
<state root>/
  lock                    # 排他ロック用（OS がプロセス終了時に解放）
  key                     # 記録の HMAC 鍵
  entries/<32桁16進ID>/
    record.json           # 記録（0600）
    repo/                  # 退避した .git とローカル設定を含むリポジトリ全体
```

root と各 entry は 0700、`key` と `record.json` は 0600 です。所有者違い・symlink・
広すぎる権限を検出した場合は黙って使わず失敗します。退避先は同じファイルシステム上の
専用領域なので、退避しても空き容量は増えません。

- 記録: 退避 ID、元パス、管理ルート、日時（UTC）、状態、検査結果、実体識別情報。
  HMAC で改ざんを検出し、退避先は ID から導出します（記録内のパスは信用しません）。
- 状態: `prepared` → `moved` → `restoring` → `restored`、移動に失敗した場合は `failed`。
- 移動: 承認後に全検査・パス同一性・ルート境界を再確認し、変化や不明があれば
  `STATE_CHANGED` で保持します（`--yes` でも同じ）。記録を同期書き込みしてから、
  既存先を上書きしない rename（macOS `renamex_np` / Linux `renameat2`）を行います。
  EXDEV・権限エラー・先の存在では元を保持して失敗し、コピー後削除には切り替えません。
- 排他: state root 単位の `flock` を取得し、同時の clean / restore は待たずにエラーにします。
  このロックは editor や Git を止めません。
- 失敗の扱い: 個別の検査失敗は次のリポジトリへ進みます。state store の破損・記録の
  永続化失敗・ロック失敗では残りの移動を止めます。移動後の記録更新に失敗した場合は
  成功と表示せず、ID を報告します。

`trash list` は記録と実体を照合して次の状態を表示し、1件が壊れていても他の履歴を表示します。

| 状態 | 意味 |
| --- | --- |
| `moved` / `restored` / `failed` | 記録と実体が一致 |
| `not_moved` | 記録は `prepared`、元あり・退避先なし（未移動） |
| `recoverable` | 元なし・退避先あり。移動済みと確認できる（`restore` 可） |
| `recovery_required` | 両方あり／両方なし／退避先の内容が変化。自動では何も削除・上書きしない |
| `invalid_record` / `orphan_entry` | 記録の破損・改ざん・権限不正／記録のない entry |

`recoverable` / `recovery_required` / `invalid_record` / `orphan_entry` があると終了値は 1 です。
state root が存在しなければ 0 件・終了0で何も作成しません。読み取り権限などで読めない場合は
空一覧とは区別して終了1とし、読めない record は `invalid_record` として他の履歴は表示します。
表示中に store が変化した場合は結果を信頼せず、再実行を案内して終了1とします。

`restore <id>` は ID 形式、所有者、記録、退避実体、親パスに symlink がないことを検証します。
復元先に何か（dangling symlink を含む）が存在する場合、または元の親ディレクトリがない場合は
拒否し、親を再作成しません。復元は確認または `--yes` の後に、上書きしない rename で行います。
ネットワーク検証は行わないので DIRTY なリポジトリも復元できます。
存在しない ID は終了1、既に `restored` の ID は再移動せず履歴を示して終了1です。
EXDEV などで移動に失敗した場合は `restoring` の `recoverable` として残り、原因を解消して再度 `restore` できます。
`recovery_required` の entry は復元せず、次の手順で調べます。

1. 他の clean / restore が動いていないことを確認する。
2. state root 全体（`key`、`entries/`）を別の場所へ保全する。
3. `record.json` の元パスと `entries/<ID>/repo` の実体、元パスの有無を照合する。
4. 衝突しない場所へ手動で保全してから調査する。整合を確認するまで clean / restore を再開しない。

0.0.0 の開発版が旧形式（`XDG_DATA_HOME` 配下の `<ID>.json`）で作った退避データは移行しません。

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
に従い、Release に添付する asset は OS-ARCH の名前を使います。
npm publish は自動実行しません。

## リリースと導入

`v1.2.3` や `v1.2.3-rc.1` のような tag を push すると、`.github/workflows/release.yml` が
Check ワークフローを再利用して品質チェック・テスト・3環境のビルドと配布検証を行い、
すべて成功した場合だけ GitHub Release を作成します。
Release には raw binary 3種と `SHA256SUMS` を添付し、ノートは自動生成します。
`-` を含む tag は prerelease になります。

```sh
git tag v0.1.0
git push origin v0.1.0
```

公開後は次のコマンドで導入・更新できます。

```sh
gh extension install UtakataKyosui/gh-local-repo-cleaner
gh extension upgrade local-repo-cleaner
```

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
