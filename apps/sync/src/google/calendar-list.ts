import type { CalendarListEntryDTO } from "@kichijitsu/shared";
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

/**
 * `calendarList.list` でカレンダー一覧を取得する。
 *
 * 呼び出し元 (core/calendar-list.ts) が status を見て 401 リトライ判定とエラー変換を行うため、
 * ここでは **response をそのまま返し throw しない** (他の google/*.ts と同じ層分担)。
 * 2026-07-31 まではこのファイルだけがこの約束を破り、自分で GoogleApiError を投げて JSON を
 * パースしていた ―― その結果 `GET /api/calendars` は**唯一 401 リトライの効かない Google
 * 呼び出し**になっており、アクセストークンが切れた瞬間にカレンダー一覧だけが 401 で落ちていた。
 */
export async function fetchCalendarList(
  fetchFn: typeof fetch,
  accessToken: string,
): Promise<Response> {
  return fetchFn("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/** fetchCalendarList の応答ボディを CalendarListEntryDTO[] に写す (ok を確認済みの応答に対して呼ぶ)。 */
export async function parseCalendarList(response: Response): Promise<CalendarListEntryDTO[]> {
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
