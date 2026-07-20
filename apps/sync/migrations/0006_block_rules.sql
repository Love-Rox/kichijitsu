-- カレンダーブロック機能 第1段階 (docs/blocking.md、2026-07-20): ブロックルールの永続化。
-- source カレンダー群の予定を target カレンダーに Busy/不在として自動複製するルールを
-- プロファイル単位で保存する。今回はルールの CRUD のみで、リコンサイル (mirror 生成) は
-- 第2段階。
--
-- BlockRuleDTO.sources は複数の (accountId, calendarId) を持つため、doc の単一列案ではなく
-- 正規化して block_rules (ルール本体 + target) と block_rule_sources (source の集合) の
-- 2テーブルに分ける。DTO へそのまま集約できる形。
CREATE TABLE block_rules (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  target_calendar_id TEXT NOT NULL,
  mode TEXT NOT NULL,          -- 'busy' | 'outOfOffice'
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_block_rules_profile ON block_rules(profile_id);

CREATE TABLE block_rule_sources (
  rule_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  PRIMARY KEY (rule_id, account_id, calendar_id)
);

-- 第2段階 (リコンサイル) で使う「ソース予定 → 生成した Busy/不在ブロック」の対応表。
-- 内容は保存しない原則により ID と時刻のみを持つ。今回は作るだけで書き込みはしない。
CREATE TABLE block_mirrors (
  rule_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  mirror_event_id TEXT NOT NULL,
  source_updated TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (rule_id, source_event_id)
);
