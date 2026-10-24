---
name: add-flag
description: gh-local-repo-cleaner の CLI にフラグを追加・変更する手順。サブコマンドの仕様は src/commands/spec.ts に集約されている。フラグ、オプション、--xxx の追加や、サブコマンドの追加・変更を頼まれたときに使う。
---

# フラグ・サブコマンドの追加手順

サブコマンドの仕様は `src/commands/spec.ts` の1か所にある。引数パーサー（`arguments.ts`）と Crust のヘルプ定義（`application.ts`）は、どちらもここから導出される。この2ファイルにフラグ名を直書きしない。

## 1. フラグを追加する

`spec.ts` を次の順で変更する。

1. `flagSpecs` にフラグを定義する（キーは `--` を除いた名前）。

   | 項目 | 内容 |
   |---|---|
   | `type` | `"boolean"` または `"string"` |
   | `description` | ヘルプ文。コマンドごとに文言が違うなら、既定の文言を置く |
   | `values` / `invalid` | 値を列挙で縛るとき。`invalid` は `UsageError` のメッセージ |
   | `absolutePath` | 絶対パスを要求するとき |
   | `excludesTarget` | target（ディレクトリ）と併用できないとき |
   | `hidden` | ヘルプに出さないとき |

2. 使わせたいコマンドの `commands.<name>.flags` にキーを足す。ヘルプ文をそのコマンドだけ変えるなら `{ description: "..." }`、既定のままなら `{}`。ここに無いフラグは「Flag is not supported for this command」で拒否される。

検証は `flagSpecs` の定義順に走る。複数が同時に不正なとき最初に出るエラーが変わるので、`status`、`group-by`、`lang`、`state-dir` の相対順は崩さない。

## 2. 値を `Invocation` に渡す

フラグの値を下流で使うなら、次の2か所を変える。

- `arguments.ts`: `Invocation` インターフェースにフィールドを足し、`normalizeArguments` の戻り値に `flags.has("name")` / `flags.get("name")` を足す。
- 使う側（`core/`、`live.ts` など）で `invocation.<field>` を読む。

## 3. サブコマンドを追加する

`commands` にエントリを足す。`Operation` 型は `keyof typeof commands` から導出されるので、型の追加は要らない。

- `run`: `"diagnose"`（診断結果を `present` で表示）か `"operate"`（`service.operate` を呼ぶ）
- `target`: 位置引数。`required`、検証用の `pattern` を持てる
- `subcommand`: `trash list` のように2語目が要るとき
- `shorthand`: `<dir> --delete` のように、コマンド名なしでフラグから選ばれるとき

## 4. 確認する

1. `bun run check` を通す（biome、fallow、tsc、テスト）。
2. ヘルプが意図せず変わっていないか、変更前後で比べる。

   ```sh
   for c in "" scan list inspect clean "trash list" restore; do
     bun src/cli.ts $c --help
   done
   ```

   `git stash -u` で変更前の出力を取り、差分を見る。追加したフラグの行だけが増えていればよい。
3. `src/commands/commands.test.ts` に、許可するコマンドと拒否するコマンドのテストを足す。
4. 新しい `UsageError` のメッセージを足した場合は、`messages.ts` の `usageJa`（正規表現と翻訳関数の表）に日本語訳を足す。足さないと `--lang ja` でも英語のまま出る。

## 注意

- フラグの値を取るとき、`--` で始まる値は「値が無い」扱いになる（`Flag requires a value`）。
- 同じフラグの重複指定は `Duplicate or malformed flag`。
- `--` 以降は位置引数として扱われ、フラグ解釈されない。
