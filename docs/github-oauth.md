# GitHub App 登録・OAuth 設定手順

GitHub 連携（docs/github-integration.md）の認証は **GitHub App の user-to-server OAuth**
で行う（2026-07-20 決定）。Google OAuth（docs/google-integration.md）の基盤
（`oauth-state` の CSRF state、`crypto.ts` の AES-GCM トークン暗号化、プロファイル連携）を
そのまま流用する。GitHub App は Google と違い OAuth の `scope` を使わず、App 定義の
Permissions が権限を決めるため、認可フロー自体は Google より単純。

## あなたの手作業: GitHub App の登録

1. GitHub → 右上アバター → **Settings** → 左下 **Developer settings** → **GitHub Apps**
   → **New GitHub App**
2. 基本情報:
   - **GitHub App name**: `kichijitsu`（取得済みなら `kichijitsu-app` 等）
   - **Homepage URL**: `https://kichijitsu.love-rox.cc`
   - **Callback URL**: 2本登録する（GitHub App は複数可）
     - `https://kichijitsu.love-rox.cc/auth/github/callback`（本番）
     - `http://localhost:8787/auth/github/callback`（ローカル開発）
   - **Expire user authorization tokens**: **オフ（チェックを外す）** ではじめる
     — 無期限のユーザートークンになり refresh 処理が不要で最小実装で動く。将来
     セキュリティを上げるならオンにして refresh 対応を足す（Google と同じ仕組みで可能）
   - **Request user authorization (OAuth) during installation**: **オン**推奨
     （インストール時にそのまま認可でき導線が1本化する）
3. **Webhook**: いまは **Active のチェックを外す**（read はポーリング＋ETag で回す。
   webhook は後のフェーズで secret とあわせて有効化する）
4. **Permissions → Repository permissions**（read 中心。①②③に必要な最小限）:
   - **Issues**: Read-only（① milestone・期限、② assigned issue）
   - **Pull requests**: Read-only（① PR、② review 依頼/自分の PR）
   - **Contents**: Read-only（③ commit 実績オーバーレイ。commits API に必要）
   - **Metadata**: Read-only（必須・自動）
   - （任意・後フェーズ用）**Projects**: Read-only（Projects v2 の date フィールド）
   - 将来の「期限の書き戻し」を見据えるなら Issues / Pull requests を後で Read & write に
     上げる（今は read のみでよい）
5. **Where can this GitHub App be installed?**:
   - 自分専用なら **Only on this account**
   - 将来一般公開/セルフホスト配布するなら **Any account**
6. **Create GitHub App** を押す。作成後の App 設定画面で:
   - **Client ID** を控える
   - **Generate a new client secret** で client secret を発行し控える（一度しか表示されない）
   - **Install App**（左メニュー）から、連携したいリポジトリに App をインストール
     （All repositories でも Only select repositories でも可。ここで選んだ repo だけ読める）

## secret の設定（あなた or 私）

発行した client_id / client_secret を Worker の secret として設定する（`vars` には**置かない**
— [[wrangler-vars-clobber-secrets]] の罠）:

```
# 本番
pnpm --filter sync exec wrangler secret put GITHUB_CLIENT_ID
pnpm --filter sync exec wrangler secret put GITHUB_CLIENT_SECRET

# ローカルは apps/sync/.dev.vars に追記
GITHUB_CLIENT_ID=Iv1.xxxxxxxx
GITHUB_CLIENT_SECRET=xxxxxxxx
```

client_secret は私（アシスタント）には貼らず、上記コマンドを `!` 付きで実行するか
ご自身で設定してください（Google の時と同じ運用）。client_id は公開情報なので共有可。

## 認可フロー（実装側の設計、参考）

- `GET /auth/github/login`（**要ログインセッション** — GitHub は既存プロファイルに
  ぶら下げる。未ログインなら先に Google 連携）:
  `https://github.com/login/oauth/authorize?client_id=...&state=...&redirect_uri=...`
  へリダイレクト。state は `oauth-state` で署名（Google と共通の CSRF 対策）。
- `GET /auth/github/callback`: `code` を
  `https://github.com/login/oauth/access_token`（`Accept: application/json`）で
  トークン交換 → access_token（無期限設定なら refresh_token なし）を
  `crypto.ts` で暗号化して `github_connections` テーブルに保存（profile 単位、1件）。
- 認可済みユーザーの識別は `GET https://api.github.com/user`（`login` / `id`）。
- レート制限: user-to-server は 5,000 req/h。read 同期は ETag で節約する。

## トラブル

- **redirect_uri は App の Callback URL と完全一致**が必要（Google の
  redirect_uri_mismatch と同種）。ローカルは `localhost:8787` を Callback URL に
  登録済みであること。
- GitHub App の Permissions を後から変えると、**インストール側で承認し直し**が要る
  （設定 → Installations → Configure）。read→write 昇格時に注意。
