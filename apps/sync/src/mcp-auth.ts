/**
 * MCP サーバー (docs/mcp.md) の Bearer トークン検証。Part B の `/mcp` ルート
 * (`Authorization: Bearer mcp_xxxx`) が唯一の呼び出し元になる想定で、
 * この関数だけを import すれば足りるように公開面を最小限にしてある。
 *
 * mcp-token.ts の純粋なフォーマット/ハッシュ関数と違い、こちらは D1 に直接触れるため
 * (このコードベースの流儀通り、api.ts の resolveGitHubAccessToken 同様) 単体テストは書かない
 * — D1 のモックをこのリポジトリに新規導入するほどの価値は無いと判断した。
 */

import { hashMcpToken, isValidMcpTokenFormat } from "./mcp-token";

/**
 * 生トークンから、それが属する profileId を解決する。
 * - フォーマット不正 (isValidMcpTokenFormat が false) は DB に触れず即 null。
 * - DB に一致する行が無ければ null。
 * - 一致すれば last_used_at を更新してから profileId を返す (最終利用時刻の記録は
 *   認証の成否には影響しない付随処理なので、更新自体の失敗で認証全体を失敗させない
 *   意図は無いが、ここでは単純に await して完了を待つ)。
 */
export async function resolveProfileFromMcpToken(
  env: Env,
  rawToken: string,
): Promise<string | null> {
  if (!isValidMcpTokenFormat(rawToken)) return null;

  const tokenHash = await hashMcpToken(rawToken);
  const row = await env.DB.prepare("SELECT id, profile_id FROM mcp_tokens WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ id: string; profile_id: string }>();
  if (!row) return null;

  await env.DB.prepare("UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?")
    .bind(Date.now(), row.id)
    .run();

  return row.profile_id;
}
