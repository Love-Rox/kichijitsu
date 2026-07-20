-- MCP サーバー (docs/mcp.md) のアクセストークン。生値は発行時に一度だけ返し、
-- サーバーは SHA-256 ハッシュのみ保存する。トークンは profile に紐づく。
CREATE TABLE mcp_tokens (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,  -- SHA-256(raw token) の hex
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_mcp_tokens_profile ON mcp_tokens(profile_id);
