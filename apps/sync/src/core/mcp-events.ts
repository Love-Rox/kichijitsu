/**
 * MCP ツール (list_events/search_events/suggest_free_slots、docs/mcp.md) 共通のイベント整形。
 */

import type { GoogleEventDTO } from "@kichijitsu/shared";
import type { BusyInterval } from "./free-slots";

export interface McpEventView {
  accountId: string;
  calendarId: string;
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  location?: string;
  htmlLink?: string;
}

/**
 * GoogleEventDTO を MCP クライアント向けの compact な view に変換する。description /
 * extendedProperties / recurrence 等は落とす — MCP クライアントには不要かつ description は
 * サイズが大きくなり得るため (search_events は shaping 前の raw event に対して検索するので、
 * description 検索自体はここでの省略に影響されない)。
 */
export function toMcpEventView(
  accountId: string,
  calendarId: string,
  event: GoogleEventDTO,
): McpEventView {
  return {
    accountId,
    calendarId,
    id: event.id,
    summary: event.summary,
    start: event.start,
    end: event.end,
    location: event.location,
    htmlLink: event.htmlLink,
  };
}

/**
 * list_events/search_events 用: 同じカレンダーが複数アカウントから見える場合 (dedupeReadTargetsByCalendar
 * で対象自体は1つに絞られるが、念のための結果側の安全網) に、同一イベントの重複を除去する。
 * `calendarId + id` の複合キーで同一視し、最初に現れたものを残す (安定ソート、入力順は保持)。
 */
export function dedupeEventViews(events: McpEventView[]): McpEventView[] {
  const seen = new Set<string>();
  const deduped: McpEventView[] = [];
  for (const event of events) {
    const key = `${event.calendarId}:${event.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

/**
 * suggest_free_slots 用: busy interval として扱えるイベントだけを busy interval に変換する。
 * - status === "cancelled" は除外
 * - start.dateTime / end.dateTime が無い (終日予定など具体的な時刻を持たない) ものは除外
 * - dateTime が Date.parse できない (不正な値) ものは除外
 */
export function toBusyIntervals(events: GoogleEventDTO[]): BusyInterval[] {
  const intervals: BusyInterval[] = [];
  for (const event of events) {
    if (event.status === "cancelled") continue;
    const startDateTime = event.start?.dateTime;
    const endDateTime = event.end?.dateTime;
    if (!startDateTime || !endDateTime) continue;

    const startMs = Date.parse(startDateTime);
    const endMs = Date.parse(endDateTime);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;

    intervals.push({ startMs, endMs });
  }
  return intervals;
}
