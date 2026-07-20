const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";

/** dateTime (時刻予定) か date (終日予定) のいずれか。GoogleEventDTO の start/end と同じ形。 */
export interface RawEventTimeField {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface PatchEventRawParams {
  calendarId: string;
  eventId: string;
  start: RawEventTimeField;
  end: RawEventTimeField;
}

/**
 * `events.patch` で start/end を Google 側の DTO 形のまま (dateTime/date どちらも可) 書き換える。
 * core/patch-event.ts の patchEventTime (epoch ms + timeZone、時刻予定限定) とは別物 —
 * カレンダーブロック機能 (docs/blocking.md 第3段階) の mirror patch は source の
 * start/end (終日予定を含む) をそのまま写す必要があるため、専用に用意する。
 * 呼び出し元 (core/patch-event-raw.ts) が status を見て 401 リトライ判定とエラー変換を
 * 行うため、ここでは response をそのまま返し throw しない (他の google/*.ts と同じ層分担)。
 */
export async function patchEventRaw(
  fetchFn: typeof fetch,
  accessToken: string,
  params: PatchEventRawParams,
): Promise<Response> {
  const url = `${CALENDAR_BASE}/${encodeURIComponent(params.calendarId)}/events/${encodeURIComponent(params.eventId)}`;
  return fetchFn(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ start: params.start, end: params.end }),
  });
}
