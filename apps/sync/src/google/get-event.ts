const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";

/**
 * `events.get` で予定を1件取得する。孤児ミラー掃除 (docs/blocking.md「将来やるならこれ」) の
 * 削除前再検証専用 (core/get-event.ts) ―― クライアントが渡してきた eventId を鵜呑みにせず、
 * 削除の直前に Google から取り直して「今も孤児と言えるか」を確認するために使う。
 *
 * RSVP の read-modify-write が使う google/rsvp-raw.ts の getEventRaw とは別に用意した:
 * あちらは「attendees の読み取りに特化した read-modify-write 専用」というコメントが付いており、
 * 削除前確認という別目的のために流用してコメントの意味を薄めたくなかったため
 * (他の google/*.ts でも用途ごとにファイルを分ける流儀 ―― delete-event.ts / insert-event.ts /
 * patch-event-raw.ts 等)。
 *
 * 呼び出し元 (core/get-event.ts) が status を見て 401 リトライ判定・404・エラー変換を行うため、
 * ここでは response をそのまま返し throw しない (他の google/*.ts と同じ層分担)。
 */
export async function getEvent(
  fetchFn: typeof fetch,
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<Response> {
  const url = `${CALENDAR_BASE}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  return fetchFn(url, { headers: { Authorization: `Bearer ${accessToken}` } });
}
