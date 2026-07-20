-- 作業実績記録 (docs/mcp.md「エージェントの作業時間記録」)。当初は Google カレンダーの専用
-- カレンダー「kichijitsu 実績」への書き込みだったが、カレンダー新規作成に calendar.events
-- スコープでは足りず 403 になる実バグが本番で判明したため D1 保存に切り替えた。work-log は
-- Google に正本が無いアプリ固有データなので、「サーバーは Google イベント本体を持たない」
-- 原則には反しない。
CREATE TABLE work_logs (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  issue_ref TEXT,
  branch TEXT,
  agent TEXT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_work_logs_profile ON work_logs(profile_id);
