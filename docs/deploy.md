# 本番デプロイ手順

本番公開先: **https://kichijitsu.love-rox.cc** (Cloudflare 管理ゾーン `love-rox.cc`)

## サービング構成

- `kichijitsu.love-rox.cc` — Worker `kichijitsu-web` (apps/web の静的アセット。Custom Domain で
  DNS レコードは自動管理される)
- `kichijitsu.love-rox.cc/api/*`, `/auth/*` — Worker `kichijitsu-sync` (apps/sync。zone route。
  同一ホスト上では zone route が Custom Domain より優先されるため、この 2 パスだけこちらに届く)
- 同一オリジンなので CORS 設定は不要。Cookie も `SameSite=Lax` のままでよい。

前提として `love-rox.cc` が対象 Cloudflare アカウントの管理ゾーンとして既に追加されていること。

## 0. 認証

```sh
mise exec -- pnpm --filter sync exec wrangler login
# もしくは CI 等では環境変数 CLOUDFLARE_API_TOKEN を設定しておく
```

以降のコマンドはすべて `apps/sync` に `wrangler` (devDependency) がインストールされている前提で、
`pnpm --filter sync exec wrangler ...` 経由で実行する (apps/web には wrangler を入れていないため、
web 側のデプロイも同じく apps/sync 経由の `wrangler --config ../web/wrangler.jsonc` を使う。
ルートの `deploy:web` / `deploy:sync` スクリプトはこれを内包している)。

## 1. D1 データベースの実体を作成

```sh
mise exec -- pnpm --filter sync exec wrangler d1 create kichijitsu-sync
```

出力される `database_id` を `apps/sync/wrangler.jsonc` の `d1_databases[0].database_id`
(現在はプレースホルダ `00000000-0000-0000-0000-000000000000`) に反映する。

反映後、`apps/sync/wrangler.jsonc` が変わったので型を再生成しておく:

```sh
mise exec -- pnpm --filter sync typecheck
```

## 2. マイグレーションをリモートに適用

```sh
mise exec -- pnpm --filter sync exec wrangler d1 migrations apply kichijitsu-sync --remote
```

未適用のマイグレーションがまとめて本番 D1 に適用される:

- `0001_init.sql` — `users` テーブル (廃止済み。0002 で `accounts` に置き換わる)
- `0002_accounts.sql` — マルチアカウント対応。`accounts(id, profile_id, email,
  refresh_token, created_at)` を作り、既存の `users` 行を `profile_id = id` として
  そのままコピーしたうえで `users` を DROP する (「1 ユーザー = 1 プロファイル」という
  前提での素朴な移行で十分と判断した理由は migration ファイル内のコメント参照)。
  ローカルで `wrangler d1 migrations apply kichijitsu-sync --local` を先に試して、
  `wrangler d1 execute kichijitsu-sync --local --command "SELECT * FROM accounts"`
  で移行結果を確認しておくと安心。

## 3. Secrets を登録

```sh
mise exec -- pnpm --filter sync exec wrangler secret put GOOGLE_CLIENT_ID
mise exec -- pnpm --filter sync exec wrangler secret put GOOGLE_CLIENT_SECRET
mise exec -- pnpm --filter sync exec wrangler secret put SESSION_SECRET
mise exec -- pnpm --filter sync exec wrangler secret put TOKEN_ENC_KEY
```

（値は `apps/sync/.dev.vars.example` のコメント参照。`SESSION_SECRET` と `TOKEN_ENC_KEY` は
`openssl rand -base64 32` などで新規に生成した、ローカル開発用とは別のランダム値を使うこと。
`TOKEN_ENC_KEY` は D1 に保存する refresh_token の at-rest 暗号化 (AES-256-GCM) に使う鍵。
これを失う、または変更すると既存ユーザーの refresh_token が復号できなくなり全員再連携が
必要になるので、生成した値は安全な場所 (パスワードマネージャ等) に控えておくこと。）

## 4. Google Cloud Console 側の設定

OAuth クライアント (`apps/sync/.dev.vars.example` で作成したものと同じクライアント) の
「承認済みのリダイレクト URI」に本番用を追加する:

```
https://kichijitsu.love-rox.cc/auth/callback
```

(ローカル開発用の `http://localhost:8787/auth/callback` は残したままでよい。)

## 5. 招待制 (ALLOWED_EMAILS) の運用

`apps/sync/wrangler.jsonc` の `vars.ALLOWED_EMAILS` はカンマ区切りのメールアドレス allowlist
で、リポジトリのデフォルトは空文字列 (＝全許可、誰でも Google 連携できる)。実際に招待制で
運用したい場合は、デプロイ先の `wrangler.jsonc` の `ALLOWED_EMAILS` に招待する本人のメール
アドレスをカンマ区切りで設定してから `pnpm run deploy:sync` すること (大小文字は区別されない)。
リスト外のメールアドレスで `/auth/callback` に到達した場合、accounts への保存 (refresh_token を
含む) は一切行われず、`APP_URL` へ `?auth_error=not_invited` を付けて 302 で戻される。招待者を
増減したいだけであれば、この値を書き換えて sync を再デプロイするだけでよい (DB 変更は不要)。

## 6. デプロイ

まず apps/web をビルドする (デプロイスクリプトはビルドを行わず、既存の `apps/web/dist` を
そのままアップロードするだけなので、必ず先にビルドすること):

```sh
mise exec -- pnpm --filter web build
```

その後、両方の Worker をデプロイする (順不同で問題ないが、`/api`・`/auth` を早く有効にしたい
場合は sync を先にすると良い):

```sh
mise exec -- pnpm run deploy:sync
mise exec -- pnpm run deploy:web
```

## 7. 検証

```sh
curl -s https://kichijitsu.love-rox.cc/api/me
# => {"connected":false,"accounts":[]}

curl -sI https://kichijitsu.love-rox.cc/
# => 200 (index.html が返る)
```

ブラウザで `https://kichijitsu.love-rox.cc/` を開いてトップページが表示されることを確認する。
続けて `/auth/login` から Google 連携フローが正常に完走し、連携後に `/api/me` が
`{"connected":true,"accounts":[{"id":"...","email":"..."}]}` を返すことも確認する。
複数アカウントを持たせたい場合は `/auth/login?add=1` (有効なセッションが必要) で
現在のプロファイルにもう1つ Google アカウントを追加できる。

## 参考: 設定変更後の型再生成

`apps/sync/wrangler.jsonc` を変更した場合は必ず以下を実行してから型チェック・デプロイすること
(bindings/vars の変更が `Env` 型に反映される):

```sh
mise exec -- pnpm --filter sync typecheck
```
