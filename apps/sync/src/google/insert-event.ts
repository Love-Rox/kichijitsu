const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";

export interface InsertEventParams<TBody extends { eventType?: "outOfOffice" }> {
  calendarId: string;
  body: TBody;
}

/**
 * `events.insert` に任意の body をそのまま送る汎用版。google/create-event.ts の
 * createEvent (title/startMs/endMs 限定) とは別物 — カレンダーブロック機能
 * (docs/blocking.md 第3段階) の mirror 作成や作業実績記録機能 (docs/mcp.md「エージェントの
 * 作業時間記録」) は extendedProperties/transparency/visibility/eventType を含む body を
 * そのまま送る必要があるため、専用に用意する。呼び出し元 (core/insert-event.ts) が status を
 * 見て 401 リトライ判定とエラー変換を行うため、ここでは response をそのまま返し throw しない
 * (他の google/*.ts と同じ層分担)。body は呼び出し元ごとに形が異なる (MirrorEventBody /
 * WorkLogEventBody 等) ため、insertEventWithRetry がリトライ判定に使う `eventType` フィールド
 * だけを制約するジェネリクスにしてある。
 */
export async function insertEvent<TBody extends { eventType?: "outOfOffice" }>(
  fetchFn: typeof fetch,
  accessToken: string,
  params: InsertEventParams<TBody>,
): Promise<Response> {
  const url = `${CALENDAR_BASE}/${encodeURIComponent(params.calendarId)}/events`;
  return fetchFn(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(params.body),
  });
}
