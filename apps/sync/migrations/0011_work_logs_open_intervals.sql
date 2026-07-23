-- 作業実績の「開区間 (実行中)」対応 (docs/mcp.md「エージェントの作業時間記録」)。作業ログの開始と
-- 停止を別々に記録できるようにするため、work_logs.end_ms を NOT NULL から NULL 許容へ変更する。
-- end_ms IS NULL の行が「開始済み・未停止 (実行中)」を表し、停止時にその行へ end_ms を書き込む。
-- SQLite は ALTER COLUMN で NOT NULL 制約を外せないため、テーブルを再構築する (新テーブル作成 →
-- INSERT ... SELECT で全行コピー → 旧 DROP → RENAME → インデックス再作成)。0010 時点の既存行は
-- end_ms が全て非 NULL のためそのまま保全される。
CREATE TABLE work_logs_new (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  issue_ref TEXT,
  branch TEXT,
  agent TEXT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER,  -- NULL 許容へ変更: NULL = 開始済み・未停止 (実行中) の開区間
  created_at INTEGER NOT NULL
);
INSERT INTO work_logs_new (id, profile_id, repo, issue_ref, branch, agent, start_ms, end_ms, created_at)
  SELECT id, profile_id, repo, issue_ref, branch, agent, start_ms, end_ms, created_at FROM work_logs;
DROP TABLE work_logs;
ALTER TABLE work_logs_new RENAME TO work_logs;

-- 0010 で作成していたプロファイル絞り込み用インデックスを再作成する (テーブル再構築で消えるため)。
CREATE INDEX idx_work_logs_profile ON work_logs(profile_id);

-- 開区間の一意制約: (profile_id, repo, issue_ref) ごとに実行中は1本まで。issue_ref NULL は
-- 空文字扱い (COALESCE) で NULL 同士も衝突させる。end_ms IS NULL の行にのみ効く部分ユニーク
-- インデックスなので、確定済み (end_ms 非 NULL) の行は同じキーで何本でも持てる。
CREATE UNIQUE INDEX idx_work_logs_open ON work_logs(profile_id, repo, COALESCE(issue_ref, '')) WHERE end_ms IS NULL;
