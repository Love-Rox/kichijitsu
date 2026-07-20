const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3/calendars'

export interface DeleteEventParams {
  calendarId: string
  eventId: string
}

/**
 * `events.delete` で予定を削除する。呼び出し元 (core/delete-event.ts) が status を見て
 * 401 リトライ判定・404 冪等成功・エラー変換を行うため、ここでは response をそのまま
 * 返し throw しない (patchEventTime と同じ層分担)。
 */
export async function deleteEvent(fetchFn: typeof fetch, accessToken: string, params: DeleteEventParams): Promise<Response> {
  const url = `${CALENDAR_BASE}/${encodeURIComponent(params.calendarId)}/events/${encodeURIComponent(params.eventId)}`
  return fetchFn(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
}
