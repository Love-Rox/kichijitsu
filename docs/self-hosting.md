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

### 運営者情報（規約・プライバシーポリシー）

`/privacy.html` `/terms.html` はあなたのドメインでもそのまま配信されます。**運営者はあなた自身
なので、あなたの情報を設定してください。**ビルド時の環境変数で差し込みます（未設定でも
kichijitsu 公式の情報が出ることはありません。「本インスタンスの運営者情報は設定されていません。」
と表示されます）。

```sh
export KICHIJITSU_OPERATOR_NAME="あなたの名前 / 組織名"
export KICHIJITSU_OPERATOR_CONTACT="you@example.com"   # 未設定なら mailto: リンクは出ません
export KICHIJITSU_INSTANCE_HOST="cal.example.com"
```

規約・ポリシーの本文そのものは kichijitsu 公式のものをひな形として同梱しています。**内容が
自分の運用に合っているかは自分で確認・修正してください**（法的な責任はインスタンスの運営者に
あります）。

### 公式インスタンスの紹介サイトは配信されません

公式サイトのランディング（`/`）・MCP 接続ガイド（`/mcp/`）・セルフホスト手順（`/self-hosting/`）は
**別パッケージ `apps/site` にあり、`pnpm build` の成果物には含まれません。**
`apps/web/dist` はまるごと配信されるので、これらが同居していると、あなたのドメインで
kichijitsu 公式インスタンスの宣伝ページが配信されてしまうためです。あなたが何もしなくても
そうならないようになっています。

そのため、あなたのインスタンスで配信されるのは次の4つだけです:

| パス            | 内容                                                         |
| --------------- | ------------------------------------------------------------ |
| `/app/`         | アプリ本体                                                   |
| `/`             | `/app/` へのリンクだけを置いた最小のページ                   |
| `/privacy.html` | プライバシーポリシー（運営者情報は上記の環境変数で差し込み） |
| `/terms.html`   | 利用規約（同上）                                             |

`/` は `apps/web/index.html` です。`apps/web/wrangler.jsonc` の
`not_found_handling: "single-page-application"` により、存在しないパスへのアクセスにもこの
ページが返ります。トップに独自の紹介ページを出したい場合はこのファイルを差し替えてください
（`/app/` へ即リダイレクトさせたいだけなら、このファイルに meta refresh を足すのが最短です。
ただし打ち間違えた URL も一緒に飛ぶ点には注意）。

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
