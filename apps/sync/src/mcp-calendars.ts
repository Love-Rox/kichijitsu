/**
 * MCP サーバー (docs/mcp.md Part B) のカレンダー対象解決、D1 に触れる側。集約ロジック本体は
 * core/mcp-targets.ts の純関数 (単体テスト済み) に切り出してある。
 *
 * mcp-auth.ts と同じ流儀により、D1 に直接触れるこのファイルには単体テストを書かない
 * (「D1 のモックをこのリポジトリに新規導入するほどの価値は無い」— mcp-auth.ts のコメント参照)。
 */

import { isAccountInProfile } from "./accounts";
import { aggregateVisibleCalendars } from "./core/visible-calendars";
import {
  resolveDefaultWriteAccountId,
  resolveReadTargets,
  type McpAccountRow,
  type McpCalendarTarget,
} from "./core/mcp-targets";

/** プロファイルに属する全アカウント (作成順)。routes/api.ts の同種クエリと同じ形。 */
export async function loadMcpProfileAccounts(
  env: Env,
  profileId: string,
): Promise<McpAccountRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, is_owner FROM accounts WHERE profile_id = ? ORDER BY created_at ASC",
  )
    .bind(profileId)
    .all<{ id: string; is_owner: number }>();
  return results.map((row) => ({ id: row.id, isOwner: row.is_owner === 1 }));
}

/**
 * routes/api.ts の loadVisibleCalendars と同じ二段クエリ + aggregateVisibleCalendars パターン。
 * accountIds が空なら D1 に触れず {} を返す (元の実装と同じガード)。
 */
export async function loadMcpVisibleCalendars(
  env: Env,
  accountIds: string[],
): Promise<Record<string, string[]>> {
  if (accountIds.length === 0) return {};

  const placeholders = accountIds.map(() => "?").join(", ");
  const prefsResult = await env.DB.prepare(
    `SELECT account_id FROM account_calendar_prefs WHERE configured = 1 AND account_id IN (${placeholders})`,
  )
    .bind(...accountIds)
    .all<{ account_id: string }>();
  const visibleResult = await env.DB.prepare(
    `SELECT account_id, calendar_id FROM account_visible_calendars WHERE account_id IN (${placeholders})`,
  )
    .bind(...accountIds)
    .all<{ account_id: string; calendar_id: string }>();

  return aggregateVisibleCalendars(
    prefsResult.results.map((row) => row.account_id),
    visibleResult.results,
  );
}

/** 読み取り系ツール向け: プロファイルの (accountId, calendarId) 対象一覧を解決する。 */
export async function resolveMcpReadTargets(
  env: Env,
  profileId: string,
): Promise<McpCalendarTarget[]> {
  const accounts = await loadMcpProfileAccounts(env, profileId);
  if (accounts.length === 0) return [];

  const visibleCalendars = await loadMcpVisibleCalendars(
    env,
    accounts.map((account) => account.id),
  );
  return resolveReadTargets(accounts, visibleCalendars);
}

/** 書き込み系ツールが accountId 省略時に使うデフォルトアカウントを解決する。 */
export async function resolveMcpDefaultWriteAccountId(
  env: Env,
  profileId: string,
): Promise<string | null> {
  const accounts = await loadMcpProfileAccounts(env, profileId);
  return resolveDefaultWriteAccountId(accounts);
}

/** 書き込み系ツールのテナント境界: 呼び出し元が指定した accountId がこのプロファイルに属するか。 */
export async function isMcpAccountOwnedByProfile(
  env: Env,
  accountId: string,
  profileId: string,
): Promise<boolean> {
  const account = await env.DB.prepare("SELECT profile_id FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ profile_id: string }>();
  return isAccountInProfile(account, profileId);
}
