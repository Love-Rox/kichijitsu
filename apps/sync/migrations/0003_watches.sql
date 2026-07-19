-- Google Calendar push 通知 (watch channel) の登録状態。
-- POST /api/watch (enabled=true) で1行作られ、enabled=false または Cron 更新での
-- 差し替えで削除/再作成される。webhook (POST /api/webhook/google) はここを
-- channel_id で引いて通知元を検証する。
CREATE TABLE watches (
  channel_id TEXT PRIMARY KEY,
  resource_id TEXT,
  account_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  expiration_ms INTEGER,
  created_at INTEGER NOT NULL
);

-- 同じ (account_id, calendar_id) に対する watch は常に高々1つ (POST /api/watch は
-- 既存 watch があれば何もしない)。
CREATE UNIQUE INDEX idx_watches_account_calendar ON watches (account_id, calendar_id);
