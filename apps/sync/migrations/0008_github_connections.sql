-- GitHub 連携 (docs/github-oauth.md)。プロファイル1つにつき GitHub アカウント1つ。
-- 正本はリモート原則により、保存するのは連携メタ + 暗号化トークンのみ。
CREATE TABLE github_connections (
  profile_id TEXT PRIMARY KEY,
  github_user_id INTEGER NOT NULL,
  github_login TEXT NOT NULL,
  access_token TEXT NOT NULL,   -- crypto.ts で AES-GCM 暗号化した文字列
  scope TEXT,
  created_at INTEGER NOT NULL
);
