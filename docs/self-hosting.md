# kichijitsu をセルフホストする

kichijitsu は**自分の Cloudflare アカウントに自分でデプロイして使う**ことを基本線にしています。
あなたのカレンダーの認可情報（Google の refresh token）は、あなた自身のアカウントの
D1 にだけ保存され、運営者を信頼する必要がありません。

公式インスタンス（https://kichijitsu.love-rox.cc）は招待制です。
自分のデータの置き場所を自分で管理したい人は、このガイドでセルフホストしてください。

## 必要なもの

- Cloudflare アカウント（**無料プランで動きます**。Durable Object は SQLite バックエンドを
  使っているため有料プランは不要）
- Cloudflare に載せたドメイン1つ（例: `kichijitsu.example.com`）。
  Web とAPI を同一オリジンで配信する構成のため、**カスタムドメインは必須**です
  （`*.workers.dev` のみでの運用は現状サポートしていません）
- Google Cloud のアカウント（無料。自分専用の OAuth クライアントを作ります）
- Node.js 26 / pnpm（リポジトリの `mise.toml` を使う場合は `mise install` だけで揃います）

## 1. リポジトリの準備

```sh
git clone https://github.com/love-rox/kichijitsu.git
cd kichijitsu
mise install   # または Node 26 を自前で用意
pnpm install
```

## 2. Google OAuth クライアントの作成

1. [Google Cloud Console](https://console.cloud.google.com/) で新規プロジェクトを作成
2. 「API とサービス」→ Google Calendar API を有効化
3. OAuth 同意画面を設定（User Type: External、**公開ステータスは「テスト」のまま**でよい。
   テストユーザーに自分の Gmail を追加）
4. 認証情報 → OAuth クライアント ID（ウェブアプリケーション）を作成し、
   承認済みリダイレクト URI に以下を追加:
   - `http://localhost:8787/auth/callback`（ローカル開発用）
   - `https://<あなたのドメイン>/auth/callback`（本番用）

自分（＋テストユーザーに追加した人）しか使わないなら、Google の審査は不要です。

## 3. 自分の環境に合わせる設定変更

以下の3箇所を自分の値に書き換えます:

| ファイル                   | 書き換える箇所                                                            |
| -------------------------- | ------------------------------------------------------------------------- |
| `apps/web/wrangler.jsonc`  | `name`（任意）、`routes[0].pattern` → あなたのドメイン                    |
| `apps/sync/wrangler.jsonc` | `name`（任意）、`routes` の 2 つの pattern と `zone_name`、`vars.APP_URL` |
| `apps/sync/wrangler.jsonc` | `d1_databases[0].database_id` → 手順4で作る実 ID                          |

## 4. デプロイ

`docs/deploy.md` の手順どおりです。要約すると:

```sh
pnpm --filter sync exec wrangler login
pnpm --filter sync exec wrangler d1 create <あなたのD1名>   # → database_id を wrangler.jsonc へ
pnpm --filter sync exec wrangler d1 migrations apply <あなたのD1名> --remote
pnpm --filter sync exec wrangler secret put GOOGLE_CLIENT_ID
pnpm --filter sync exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm --filter sync exec wrangler secret put SESSION_SECRET   # ランダムな長い文字列
pnpm --filter sync exec wrangler secret put TOKEN_ENC_KEY     # openssl rand -base64 32 (refresh_token 暗号化鍵)
pnpm --filter web build
pnpm run deploy:sync
pnpm run deploy:web
```

## 5. 推奨のセキュリティ設定

- `ALLOWED_EMAILS`（`apps/sync/wrangler.jsonc` の vars）に自分のメールアドレスを設定して
  おくと、OAuth 設定を誤って公開した場合でもサーバー側で登録を拒否できます
- Cloudflare ダッシュボードで `/auth/*` `/api/*` への Rate Limiting ルールを追加すると
  さらに安心です（無料枠あり）

## ローカル開発

```sh
cp apps/sync/.dev.vars.example apps/sync/.dev.vars   # 値を記入
pnpm --filter sync dev    # localhost:8787
pnpm dev                  # localhost:5173 (API は自動でプロキシ)
```

## 公式インスタンスとの関係

- 公式インスタンス（kichijitsu.love-rox.cc）は招待制で運用しています
- 将来的に、審査済みの公式 API（レート制限・API キー付き）の提供を検討しています。
  それまでは「自分の分は自分でデプロイ」が最も安全な使い方です
