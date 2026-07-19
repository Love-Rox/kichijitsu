-- マルチアカウント対応: セッション (プロファイル) 1つに複数の Google アカウントを
-- ぶら下げられるようにする。プロファイルは Google のどの概念とも対応しない、
-- このアプリだけのローカルな論理グループ (sid cookie が署名する uuid)。
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,          -- Google の sub
  profile_id TEXT NOT NULL,     -- このアカウントが属するプロファイル (sid が署名する uuid)
  email TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_accounts_profile_id ON accounts (profile_id);

-- 既存の users 行 (= 1 ユーザー 1 プロファイル 1 アカウントだった時代のデータ) を
-- そのまま accounts へ移す。プロファイル id が存在しないので、Google sub をそのまま
-- profile_id として使う (accounts.id と同じ値になるが、意味的には別の列)。
-- 本番はまだテストユーザーのダミーデータしか無く、これで実用上十分なため、
-- 「1 ユーザー = 1 プロファイル」という前提以上に凝った移行ロジックは書かない。
INSERT INTO accounts (id, profile_id, email, refresh_token, created_at)
SELECT id, id, email, refresh_token, created_at FROM users;

DROP TABLE users;
