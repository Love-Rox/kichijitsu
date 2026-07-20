# ツールチェーン (Vite+ / vp)

`chore/vite-plus-ts7` での移行内容のまとめ。dev/build/test/lint/format を
[Vite+](https://viteplus.dev/) (`vp` コマンド) に統一し、あわせて TypeScript 7
(`tsgo` によるネイティブ型チェック) を導入した。

## 採用範囲

- `apps/web` — dev/build/test/lint/fmt すべて `vp` 経由。
- `apps/sync` (Cloudflare Workers) — **デプロイは従来どおり `wrangler`**。
  `vp` はテスト実行のみに使う (`dev`/`deploy` は wrangler のまま)。
- `packages/shared` — 型のみのパッケージなのでビルド/テストなし、対象外。
- ルートの `vite.config.ts` はワークスペース全体の `vp fmt` / `vp lint` 集約設定。

## コマンド対応表 (旧 → 新)

| 用途         | 旧 (vite/vitest/oxlint 個別) | 新 (`vp`)                           |
| ------------ | ---------------------------- | ----------------------------------- |
| 開発サーバ   | `vite`                       | `vp dev`                            |
| ビルド       | `tsc -b && vite build`       | `tsc -b && vp build`                |
| Lint         | `oxlint`                     | `vp lint`                           |
| テスト       | `vitest run`                 | `vp test run`                       |
| プレビュー   | `vite preview`               | `vp preview`                        |
| フォーマット | (未整備)                     | `vp fmt` / `vp fmt --check`         |
| まとめて確認 | -                            | `vp check` (fmt + lint + typecheck) |

`apps/sync` の `dev` / `deploy` は `wrangler dev` / `wrangler deploy` のまま変更していない。

## 整形規約: ダブルクォート + セミコロンあり

`vp fmt` (oxfmt) の既定に合わせ、コードベース全体を **ダブルクォート＋セミコロンあり**
に統一整形した (従来はシングルクォート＋セミコロンなしの箇所が混在していた)。
これは意図的な変更であり、今後もこの規約を維持する。lint 側でシングルクォートに
戻すような設定は入れていない。

## vitest 統合で踏んだ落とし穴

`vp migrate` 後、`apps/web` (devDependency に `vitest` を直接持たない構成)
で `vp test run` を実行すると、全テストファイルが

```
TypeError: Cannot read properties of undefined (reading 'config')
```

(あるいは `Vitest failed to find the runner`) で失敗し、収集テスト数が 0 になる
現象が発生した。テストファイル自体はすでに `vp migrate` によって
`import { describe, ... } from "vite-plus/test"` に書き換え済みで、
`vite.config.ts` の `test` ブロックにも問題はなかった。

調査の結果、原因はプロジェクト側ではなく **`~/.local/share/mise/...` にグローバル
インストールされた `vp` バイナリ側**にあった。`vp` の設計上、グローバル CLI から
実行された場合は「プロジェクトローカルの `vite-plus` インストールを検出し、その
`dist/bin.js` に処理を委譲する」ことになっているが、この環境では `test` サブコマンド
実行時にその委譲が行われていないことをマーカー注入で確認した (ローカルの
`dist/bin.js` が一度もロードされない)。結果として、テストランナーが使う vitest
インスタンス (グローバルインストール側) と、各テストファイルが `vite-plus/test`
経由で解決する vitest インスタンス (プロジェクトローカル側) が物理的に別モジュール
になり、vitest 自身が警告する「複数の vitest インストール」状態と同じ壊れ方をする。

実際、プロジェクトローカルの `vite-plus` の `bin/vp` (= `apps/web/node_modules/.bin/vp`)
を直接叩くと問題なく通ることを確認済み。

**対策**: 素の `vp` (グローバル PATH 解決) を直接叩くのではなく、常に **`pnpm`
経由**で実行する。

```sh
pnpm --filter web test      # apps/web の package.json の "test": "vp test run" を実行
pnpm --filter web exec vp check
pnpm exec vp fmt --check    # ルートから全体を確認する場合
```

`pnpm run` / `pnpm --filter <pkg> <script>` / `pnpm exec` はスクリプト実行時に
各パッケージの `node_modules/.bin` を PATH の先頭に挿入するため、プロジェクトローカルの
`vite-plus` (と、それが内部で使う vitest インスタンス) が一貫して使われ、上記の
モジュール不一致が起きない。これでプロジェクト側の設定・テストコードは一切変更せずに
`apps/web` 228 件・`apps/sync` 180 件とも全数 pass する状態になった。

このリポジトリでは元々 `docs/deploy.md` などでも `pnpm --filter <pkg> ...` の形が
使われているので、運用上の変更というより既存の作法への統一。

## TypeScript 7 / tsgo によるネイティブ型チェック

`apps/web` / `apps/sync` の `typescript` を `^7.0.2` に、あわせてネイティブ実装の
型チェッカー [`@typescript/native-preview`](https://www.npmjs.com/package/@typescript/native-preview)
(`tsgo` コマンド、`7.0.0-dev` 系) を devDependency に追加した。

- **`typecheck` スクリプト** (両 app とも新設 / 更新) は `tsgo` を使い高速に型チェックのみ行う:
  - `apps/web`: `tsgo -b` (`tsconfig.json` の project references 構成をそのままビルドモードで
    チェックできることを確認済み)
  - `apps/sync`: `wrangler types && tsgo --noEmit`
- **`build` は従来どおり `tsc -b && vp build`** のまま変更していない (安全側、正式な `tsc` を使う)。
- `tsgo -b` / `tsgo --noEmit` はいずれもエラー 0、既存の `tsc -b` / `tsc --noEmit` も TS7 で
  エラー 0 のまま。TS7 化にともなうソースコードの修正は不要だった (型エラーの新規発生なし)。
- 実行例:

  ```sh
  pnpm --filter web run typecheck    # tsgo -b
  pnpm --filter sync run typecheck   # wrangler types && tsgo --noEmit
  ```

## 既知の警告 (対応不要)

- `pnpm` 実行時に毎回出る `Unsupported engine: wanted: {"node":">=26"}` は無視してよい
  (ローカル/CI の node バージョン方針は本移行の対象外)。
- TS7 化後、`vp lint` (type-aware) でわずかに新規の警告 (`no-floating-promises` /
  `no-base-to-string` など) が増えたが、いずれも警告どまりで exit code は 0。
  型エラーではないため今回のスコープ (フォーマット以外のロジック変更をしない) では
  修正していない。
