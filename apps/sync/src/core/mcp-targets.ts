/**
 * MCP サーバー (docs/mcp.md Part B) のカレンダー対象解決。プロファイルの
 * account_visible_calendars 選択 (aggregateVisibleCalendars が返す Record<accountId,
 * calendarId[]>) を、MCP ツールがそのまま反復できるフラットな (accountId, calendarId) の
 * リストに変換する。
 *
 * 「選択が1件も無い (未設定/新規アカウント)」場合のフォールバックもここに持つ:
 * オーナーアカウントの primary カレンダー ("primary" は Google の literal alias で、
 * カレンダー一覧を引かなくても events.list/insert/patch/delete にそのまま使える)。
 */

export interface McpAccountRow {
  id: string;
  isOwner: boolean;
}

export interface McpCalendarTarget {
  accountId: string;
  calendarId: string;
}

/** aggregateVisibleCalendars が返す Record<accountId, calendarId[]> をフラットな pair 列に変換する。 */
export function flattenVisibleCalendarTargets(
  visibleCalendars: Record<string, string[]>,
): McpCalendarTarget[] {
  const targets: McpCalendarTarget[] = [];
  for (const [accountId, calendarIds] of Object.entries(visibleCalendars)) {
    for (const calendarId of calendarIds) {
      targets.push({ accountId, calendarId });
    }
  }
  return targets;
}

/**
 * 選択が1件も無い場合のフォールバック対象: オーナーアカウントの "primary" カレンダー。
 * オーナーが見つからない (migration 0004_owner.sql により通常起こり得ないが、防御的に)
 * 場合は先頭のアカウントを使う。アカウントが1つも無ければ null。
 */
export function resolveFallbackTarget(accounts: McpAccountRow[]): McpCalendarTarget | null {
  if (accounts.length === 0) return null;
  const owner = accounts.find((account) => account.isOwner) ?? accounts[0];
  return { accountId: owner.id, calendarId: "primary" };
}

/**
 * 読み取り系ツール向けの対象解決本体: 選択 (visibleCalendars) をフラット化した結果が
 * 1件以上あればそれを使い、無ければ resolveFallbackTarget にフォールバックする。
 * アカウントも選択も両方空なら空配列 (対象なし)。
 */
export function resolveReadTargets(
  accounts: McpAccountRow[],
  visibleCalendars: Record<string, string[]>,
): McpCalendarTarget[] {
  const flattened = flattenVisibleCalendarTargets(visibleCalendars);
  if (flattened.length > 0) return flattened;

  const fallback = resolveFallbackTarget(accounts);
  return fallback ? [fallback] : [];
}

/** 書き込み系ツールが accountId 省略時に使うデフォルトアカウント: オーナー優先、無ければ先頭、無ければ null。 */
export function resolveDefaultWriteAccountId(accounts: McpAccountRow[]): string | null {
  if (accounts.length === 0) return null;
  const owner = accounts.find((account) => account.isOwner) ?? accounts[0];
  return owner.id;
}
