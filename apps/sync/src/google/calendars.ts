import { GoogleApiError } from "../core/errors";
import { fetchCalendarList } from "./calendar-list";

/**
 * 作業実績記録機能 (docs/mcp.md「エージェントの作業時間記録」) が使う「kichijitsu 実績」
 * カレンダーの find-or-create のうち find 側。calendarList を fetchCalendarList で取得し
 * summary が完全一致するものを探すだけ (id で引く手段が無いので summary で照合する)。
 * 同名カレンダーが複数あっても最初の1件を返す (通常は自分で作った1件のみのはず)。
 */
export async function findCalendarBySummary(
  fetchFn: typeof fetch,
  accessToken: string,
  summary: string,
): Promise<string | null> {
  const calendars = await fetchCalendarList(fetchFn, accessToken);
  const match = calendars.find((cal) => cal.summary === summary);
  return match ? match.id : null;
}

interface RawCalendarCreateResponse {
  id: string;
}

/**
 * 作業実績記録機能 (docs/mcp.md「エージェントの作業時間記録」) が使う「kichijitsu 実績」
 * カレンダーの find-or-create のうち create 側。calendars.insert を叩いて新規カレンダーを
 * 作成し、その id を返す。timeZone 省略時は Google のアカウント既定タイムゾーンが使われる。
 */
export async function createCalendar(
  fetchFn: typeof fetch,
  accessToken: string,
  summary: string,
  timeZone?: string,
): Promise<string> {
  const response = await fetchFn("https://www.googleapis.com/calendar/v3/calendars", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(timeZone ? { summary, timeZone } : { summary }),
  });
  if (!response.ok) {
    throw new GoogleApiError(response.status, await response.text());
  }
  const data = (await response.json()) as RawCalendarCreateResponse;
  return data.id;
}
