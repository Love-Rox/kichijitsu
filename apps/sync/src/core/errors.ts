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
