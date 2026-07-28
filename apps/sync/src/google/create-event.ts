import { toDateOnly, toRfc3339Utc } from "./patch-event";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";

export interface CreateEventParams {
  calendarId: string;
  title: string;
  startMs: number;
  endMs: number;
  /** クライアントの IANA タイムゾーン。dateTime と併記して Google に渡す (isAllDay の date 変換にも使う)。 */
  timeZone: string;
  /**
   * 指定時のみ body に含める (undefined は「未指定」= Google のデフォルト = 未設定)。
   * patch と違い「空文字でクリア」の概念は無い — 作成時に消すべき既存値が無いため
   * (2026-07-29 全項目入力)。
   */
  location?: string;
  description?: string;
  /**
   * true なら start/end を `date` (終日) 形式で送る (2026-07-29 全項目入力)。
   * false/未指定は従来どおり `dateTime` (時刻予定)。
   */
  isAllDay?: boolean;
}

/**
 * `events.insert` で新規予定を作成する。patch-event.ts の toRfc3339Utc と同じ理由で
 * dateTime は常に UTC 表記 (`Date#toISOString()`) + timeZone 併記で送る。終日予定は
 * patchEventTime と同じく `date` (toDateOnly、endMs は排他的) に変換して送る。
 * location/description は undefined ならキー自体を body に含めない (JSON.stringify が
 * undefined なプロパティを省略する挙動をそのまま利用、patchEventTime と同じ流儀)。
 * 呼び出し元 (core/create-event.ts) が status を見て
 * 401 リトライ判定とエラー変換を行うため、ここでは response をそのまま返し throw しない
 * (patchEventTime と同じ層分担)。
 */
export async function createEvent(
  fetchFn: typeof fetch,
  accessToken: string,
  params: CreateEventParams,
): Promise<Response> {
  const url = `${CALENDAR_BASE}/${encodeURIComponent(params.calendarId)}/events`;
  const start = params.isAllDay
    ? { date: toDateOnly(params.startMs, params.timeZone) }
    : { dateTime: toRfc3339Utc(params.startMs), timeZone: params.timeZone };
  const end = params.isAllDay
    ? { date: toDateOnly(params.endMs, params.timeZone) }
    : { dateTime: toRfc3339Utc(params.endMs), timeZone: params.timeZone };
  return fetchFn(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: params.title,
      start,
      end,
      location: params.location,
      description: params.description,
    }),
  });
}
