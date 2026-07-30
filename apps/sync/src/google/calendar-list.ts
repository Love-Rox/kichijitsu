import type { CalendarListEntryDTO } from "@kichijitsu/shared";
import { GoogleApiError } from "../core/errors";
import { derivePopupReminderMinutes } from "../core/google-events";

interface RawCalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
  backgroundColor?: string;
  accessRole?: "owner" | "writer" | "reader" | "freeBusyReader";
  /**
   * このカレンダーの既定リマインダー (2026-07-31)。予定側が reminders.useDefault:true の
   * ときの実際の分数は**ここにしか無い** (公式: 既定リマインダーは CalendarList にあり
   * Calendars には無い)。overrides とまったく同じ `{ method, minutes }` の形なので、
   * popup への絞り込みは events 側と同じ derivePopupReminderMinutes を使う。
   */
  defaultReminders?: { method?: string; minutes?: number }[];
}

interface RawCalendarListResponse {
  items: RawCalendarListEntry[];
}

export async function fetchCalendarList(
  fetchFn: typeof fetch,
  accessToken: string,
): Promise<CalendarListEntryDTO[]> {
  const response = await fetchFn("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new GoogleApiError(response.status, await response.text());
  }
  const data = (await response.json()) as RawCalendarListResponse;
  return data.items.map((item) => ({
    id: item.id,
    summary: item.summary,
    primary: item.primary,
    backgroundColor: item.backgroundColor,
    accessRole: item.accessRole,
    // 空配列も意味を持つ (「既定リマインダーが無いカレンダー」= 祝日・購読カレンダー等) ので
    // 常に載せる。Google が defaultReminders 自体を返さなかった場合も空配列に落ちる
    defaultReminderMinutes: derivePopupReminderMinutes(item.defaultReminders),
  }));
}
