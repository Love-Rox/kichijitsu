import { toRfc3339Utc } from "./patch-event";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";

export interface CreateEventParams {
  calendarId: string;
  title: string;
  startMs: number;
  endMs: number;
  /** クライアントの IANA タイムゾーン。dateTime と併記して Google に渡す。 */
  timeZone: string;
}

/**
 * `events.insert` で新規予定を作成する。patch-event.ts の toRfc3339Utc と同じ理由で
 * dateTime は常に UTC 表記 (`Date#toISOString()`) + timeZone 併記で送る。
 * 終日予定は未対応 (時刻予定のみ)。呼び出し元 (core/create-event.ts) が status を見て
 * 401 リトライ判定とエラー変換を行うため、ここでは response をそのまま返し throw しない
 * (patchEventTime と同じ層分担)。
 */
export async function createEvent(
  fetchFn: typeof fetch,
  accessToken: string,
  params: CreateEventParams,
): Promise<Response> {
  const url = `${CALENDAR_BASE}/${encodeURIComponent(params.calendarId)}/events`;
  return fetchFn(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: params.title,
      start: { dateTime: toRfc3339Utc(params.startMs), timeZone: params.timeZone },
      end: { dateTime: toRfc3339Utc(params.endMs), timeZone: params.timeZone },
    }),
  });
}
