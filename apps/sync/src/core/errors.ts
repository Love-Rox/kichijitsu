/** Google の syncToken が失効した (HTTP 410) ことを表す。呼び出し側は全同期にフォールバックする。 */
export class SyncTokenExpiredError extends Error {
  constructor() {
    super("Google Calendar sync token expired (410)");
    this.name = "SyncTokenExpiredError";
  }
}

/**
 * Google Calendar API がエラーを返した (401 リトライ後もなお失敗 / 429 / 5xx など)。
 * ここで握りつぶさずそのまま呼び出し元 (HTTP ハンドラ) まで伝播させ、エラーレスポンスにする。
 */
export class GoogleApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Google Calendar API error: HTTP ${status}: ${body}`);
    this.name = "GoogleApiError";
    this.status = status;
    this.body = body;
  }
}

/** ユーザーが未連携 (D1 に refresh_token が無い) 場合。 */
export class NotConnectedError extends Error {
  constructor() {
    super("User has not connected a Google account");
    this.name = "NotConnectedError";
  }
}

/**
 * RSVP (2026-07-22): events.get で取得した event.attendees[] に self:true のエントリが
 * 無い場合。自分だけの予定 (招待者がいない) や、そもそも自分が招待されていない予定
 * (共有カレンダー越しに見えているだけ等) は RSVP のしようがないため、握りつぶさず
 * 呼び出し元 (route) まで伝播させ、422 not_an_attendee として明確にエラーにする
 * (rpc-result.ts の runRpc / routes/api.ts の /api/event/rsvp 参照)。
 */
export class NotAnAttendeeError extends Error {
  constructor() {
    super("Self attendee not found on this event (not invited, or an event with no attendees)");
    this.name = "NotAnAttendeeError";
  }
}
