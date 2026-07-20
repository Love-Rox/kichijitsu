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
 * 同じ calendarId が複数アカウントから見える場合 (例: 複数の Google アカウントに同じ
 * sasagar@gmail.com が追加されている) に、target を1件へ収束させる。選択則は完全に
 * 決定的にする: その calendarId の target 群にオーナーアカウントのものがあればそれを
 * 採用し、無ければ accountId の文字列比較 (`<`) で昇順最小の target を採用する
 * (tie-break の再現性のため)。
 */
export function dedupeReadTargetsByCalendar(
  targets: McpCalendarTarget[],
  accounts: McpAccountRow[],
): McpCalendarTarget[] {
  const ownerAccountIds = new Set(
    accounts.filter((account) => account.isOwner).map((account) => account.id),
  );

  const groupsByCalendarId = new Map<string, McpCalendarTarget[]>();
  for (const target of targets) {
    const group = groupsByCalendarId.get(target.calendarId);
    if (group) {
      group.push(target);
    } else {
      groupsByCalendarId.set(target.calendarId, [target]);
    }
  }

  const deduped: McpCalendarTarget[] = [];
  for (const group of groupsByCalendarId.values()) {
    const ownerTarget = group.find((target) => ownerAccountIds.has(target.accountId));
    if (ownerTarget) {
      deduped.push(ownerTarget);
      continue;
    }
    deduped.push(
      group.reduce((smallest, target) =>
        target.accountId < smallest.accountId ? target : smallest,
      ),
    );
  }
  return deduped;
}

/**
 * 読み取り系ツール向けの対象解決本体: 選択 (visibleCalendars) をフラット化した結果が
 * 1件以上あれば dedupeReadTargetsByCalendar で calendarId 単位に収束させて使い、無ければ
 * resolveFallbackTarget にフォールバックする。アカウントも選択も両方空なら空配列 (対象なし)。
 */
export function resolveReadTargets(
  accounts: McpAccountRow[],
  visibleCalendars: Record<string, string[]>,
): McpCalendarTarget[] {
  const flattened = flattenVisibleCalendarTargets(visibleCalendars);
  if (flattened.length > 0) return dedupeReadTargetsByCalendar(flattened, accounts);

  const fallback = resolveFallbackTarget(accounts);
  return fallback ? [fallback] : [];
}

/** 書き込み系ツールが accountId 省略時に使うデフォルトアカウント: オーナー優先、無ければ先頭、無ければ null。 */
export function resolveDefaultWriteAccountId(accounts: McpAccountRow[]): string | null {
  if (accounts.length === 0) return null;
  const owner = accounts.find((account) => account.isOwner) ?? accounts[0];
  return owner.id;
}
