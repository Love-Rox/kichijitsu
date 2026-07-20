/**
 * MCP `search_events` ツール (docs/mcp.md) のキーワード検索本体。
 */

import type { GoogleEventDTO } from "@kichijitsu/shared";

const DEFAULT_SEARCH_WINDOW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SEARCH_WINDOW_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

/** timeMin/timeMax 省略時のデフォルト検索窓: 今日の30日前〜90日後 (RFC3339)。 */
export function defaultSearchWindow(nowMs: number): { timeMin: string; timeMax: string } {
  return {
    timeMin: new Date(nowMs - DEFAULT_SEARCH_WINDOW_BEFORE_MS).toISOString(),
    timeMax: new Date(nowMs + DEFAULT_SEARCH_WINDOW_AFTER_MS).toISOString(),
  };
}

/**
 * summary/description/location のいずれかに大文字小文字を無視した部分一致があるイベントだけを
 * 残す。query が空/空白のみの場合はフィルタせずそのまま返す。
 */
export function filterEventsByQuery(events: GoogleEventDTO[], query: string): GoogleEventDTO[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return events;

  const needle = trimmed.toLowerCase();
  return events.filter((event) => {
    const haystacks = [event.summary, event.description, event.location];
    return haystacks.some((field) => field !== undefined && field.toLowerCase().includes(needle));
  });
}
