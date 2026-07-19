const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3/calendars'

export interface PatchEventTimeParams {
  calendarId: string
  eventId: string
  startMs: number
  endMs: number
  /** クライアントの IANA タイムゾーン。dateTime と併記して Google に渡す。 */
  timeZone: string
}

/**
 * epoch ms を RFC3339 (UTC, "Z" 付き) に変換する。
 * Google Calendar API の start/end.dateTime は UTC オフセット付き RFC3339 であれば
 * よく、`date-fns-tz` 等でクライアントのローカル時刻表記に組み立て直す必要はない —
 * timeZone フィールドを併記すれば、表示や繰り返し予定 (RRULE) の計算はそちらを
 * 正として Google 側が扱ってくれるため、dateTime 自体は常に UTC 表記
 * (`Date#toISOString()`) で送って問題ない。
 */
export function toRfc3339Utc(ms: number): string {
  return new Date(ms).toISOString()
}

/**
 * `events.patch` で start/end のみを書き換える。他のフィールド (summary/description 等)
 * には触れない。呼び出し元 (core/patch-event.ts) が status を見て 401 リトライ判定と
 * エラー変換を行うため、ここでは response をそのまま返し throw しない
 * (fetchEventsPage と同じ層分担)。
 */
export async function patchEventTime(
  fetchFn: typeof fetch,
  accessToken: string,
  params: PatchEventTimeParams,
): Promise<Response> {
  const url = `${CALENDAR_BASE}/${encodeURIComponent(params.calendarId)}/events/${encodeURIComponent(params.eventId)}`
  return fetchFn(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      start: { dateTime: toRfc3339Utc(params.startMs), timeZone: params.timeZone },
      end: { dateTime: toRfc3339Utc(params.endMs), timeZone: params.timeZone },
    }),
  })
}
