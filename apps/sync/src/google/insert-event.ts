import type { MirrorEventBody } from "../core/block-reconcile";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";

export interface InsertEventParams {
  calendarId: string;
  body: MirrorEventBody;
}

/**
 * `events.insert` に任意の body をそのまま送る汎用版。google/create-event.ts の
 * createEvent (title/startMs/endMs 限定) とは別物 — カレンダーブロック機能
 * (docs/blocking.md 第3段階) の mirror 作成は extendedProperties/transparency/
 * visibility/eventType を含む body をそのまま送る必要があるため、専用に用意する。
 * 呼び出し元 (core/insert-event.ts) が status を見て 401 リトライ判定とエラー変換を
 * 行うため、ここでは response をそのまま返し throw しない (他の google/*.ts と同じ層分担)。
 */
export async function insertEvent(
  fetchFn: typeof fetch,
  accessToken: string,
  params: InsertEventParams,
): Promise<Response> {
  const url = `${CALENDAR_BASE}/${encodeURIComponent(params.calendarId)}/events`;
  return fetchFn(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(params.body),
  });
}
