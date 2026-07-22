const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";

/**
 * events.get/events.patch の attendee 1件。Google が返すフィールドは他にも displayName/
 * optional/organizer/resource 等があるが、kichijitsu が読むのは email/self/responseStatus
 * のみ (RSVP に必要な最小限)。events.patch の attendees は全置換 (マージではない) なので、
 * read-modify-write で書き戻す配列は events.get で読んだ他のフィールドもそのまま保持する
 * 必要がある — そのため型を絞らず未知のプロパティも透過する ([key: string]: unknown)。
 */
export interface RawAttendee {
  email?: string;
  self?: boolean;
  responseStatus?: string;
  [key: string]: unknown;
}

interface RawEventAttendees {
  attendees?: RawAttendee[];
}

/**
 * `events.get` で event 1件を取得する。RSVP の read-modify-write の read 側
 * (core/rsvp-event.ts) 専用 — attendees 以外のフィールドも Google はそのまま返すが、
 * ここでは呼び出し元が JSON パース後に attendees だけを見るので型は絞らない。
 * 呼び出し元が status を見て 401 リトライ判定とエラー変換を行うため、ここでは
 * response をそのまま返し throw しない (他の google/*.ts と同じ層分担)。
 */
export async function getEventRaw(
  fetchFn: typeof fetch,
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<Response> {
  const url = `${CALENDAR_BASE}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  return fetchFn(url, { headers: { Authorization: `Bearer ${accessToken}` } });
}

/** getEventRaw のレスポンスボディから attendees[] を取り出す (無ければ空配列)。 */
export async function parseEventAttendees(response: Response): Promise<RawAttendee[]> {
  const body = (await response.json()) as RawEventAttendees;
  return body.attendees ?? [];
}

/**
 * `events.patch` で attendees 配列全体を書き換える (全置換 — マージではない点が
 * 他の patch-event*.ts と異なる、Google API の制約)。`sendUpdates=all` を付ける:
 * RSVP は「自分の応答を主催者/他の参加者に伝える」行為そのものなので、通知を
 * 送らない (sendUpdates=none) 選択肢は RSVP の意味を損なう — 明示的に all を指定する。
 * 呼び出し元が status を見て 401 リトライ判定とエラー変換を行うため、ここでは
 * response をそのまま返し throw しない。
 */
export async function patchAttendeesRaw(
  fetchFn: typeof fetch,
  accessToken: string,
  calendarId: string,
  eventId: string,
  attendees: RawAttendee[],
): Promise<Response> {
  const url = `${CALENDAR_BASE}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`;
  return fetchFn(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ attendees }),
  });
}
