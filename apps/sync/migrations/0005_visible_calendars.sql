-- カレンダー選択のサーバー保存 (2026-07-20): 「どのカレンダーを表示するか」の選択が
-- これまで端末ローカル (IndexedDB) のみで、端末間で揃わなかった (別端末で一部カレンダーが
-- 出ない原因)。これを D1 に保存し、GET /api/me で返して端末間の選択を揃える。
--
-- 「未設定 (行が無い＝クライアントが primary をデフォルト選択する)」と「空選択
-- (全部外した、という明示的な意思)」を区別する必要があるため、選択の実体
-- (account_visible_calendars) とは別に「このアカウントは選択を設定済みか」を持つ
-- account_calendar_prefs を併設する。PUT /api/visible-calendars が来たら configured=1 を
-- 立てる。GET 側の集約ロジックは apps/sync/src/core/visible-calendars.ts 参照。
CREATE TABLE account_visible_calendars (
  account_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, calendar_id)
);

CREATE TABLE account_calendar_prefs (
  account_id TEXT PRIMARY KEY,
  configured INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER
);
