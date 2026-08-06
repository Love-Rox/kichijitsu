-- デスクトップ版 (Tauri) の外部ブラウザ OAuth で使う「使い捨てチケット」(2026-08-07)。
--
-- 背景: Google は埋め込み webview からの OAuth を禁止しており、デスクトップ版から
-- 連携しようとすると 401: disabled_client で弾かれる (2026-08-06 に本番で確認)。
-- そこで OAuth 自体は外部ブラウザで完了させ、カスタム URL スキーム (kichijitsu://) で
-- アプリへ戻り、このチケットを webview 側のセッション Cookie に交換する。
-- 設計の詳細は src/core/desktop-auth.ts / src/routes/desktop-auth.ts の冒頭コメント参照。
--
-- なぜ D1 か (DO ではなく):
--   - 発行 (/auth/callback) も交換 (/auth/desktop/exchange) も同じ Worker の中で起きるので、
--     すでに手元にある DB バインディングで完結する。DO を1クラス増やすと wrangler の
--     migrations と RPC 1往復が増えるだけで、得るものが無い。
--   - 単回使用は「行を DELETE できたか (meta.changes === 1)」で担保できる。D1 の 1 文は
--     アトミックなので、同じチケットで同時に2本来ても消せるのは片方だけ = 二重交換にならない。
--     DO の直列実行が必要になるのは「読んで→考えて→書く」を不可分にしたい場合だが、
--     ここは「消せたら勝ち」の1文で表現できるためその必要が無い。
--   - profiles/accounts と同じ D1 に置くことで、プロファイルの実体と寿命が揃う。
--
-- 生値 (ticket) は保存しない。mcp_tokens と同じく SHA-256 の hex だけを持つ ―― 照合しか
-- しないので元へ戻す必要が無く、DB が漏れてもチケットは再現できない。
-- challenge は「このチケットを取りに行ったアプリだけが持つ verifier」の SHA-256 (PKCE 相当)。
-- 交換時にこれが一致しないと Cookie を発行しない = 悪意ある kichijitsu:// リンクを踏ませて
-- 他人のアカウントでログインさせる (ログイン CSRF) が成立しない。
--
-- 行は交換時に必ず削除され、残骸も発行のたびに expires_at で掃除するため、常に数行しか
-- 存在しない (専用の Cron は置かない)。
CREATE TABLE desktop_auth_tickets (
  ticket_hash TEXT PRIMARY KEY,     -- SHA-256(raw ticket) の hex
  profile_id TEXT NOT NULL,         -- 交換時に sid として発行するプロファイル
  challenge TEXT NOT NULL,          -- SHA-256(verifier) の hex。アプリとの結び付け
  expires_at INTEGER NOT NULL,      -- epoch ms。これを過ぎた行は交換できない
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_desktop_auth_tickets_expires ON desktop_auth_tickets(expires_at);
