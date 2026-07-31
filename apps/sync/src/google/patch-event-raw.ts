import type { EventSendUpdates } from "@kichijitsu/shared";

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
  /**
   * ゲストへの通知 (2026-07-31)。patchEventTime / deleteEvent とまったく同じ理由で
   * **optional にしない** ―― 省略できる形にした瞬間に「うっかり付け忘れて Google の
   * 未文書の既定に落ちる」が復活する。呼び出し側 (core/patch-event-raw.ts) に必ず決めさせる。
   */
  sendUpdates: EventSendUpdates;
}

/**
 * `events.patch` で start/end を Google 側の DTO 形のまま (dateTime/date どちらも可) 書き換える。
 * core/patch-event.ts の patchEventTime (epoch ms + timeZone、時刻予定限定) とは別物 —
 * カレンダーブロック機能 (docs/blocking.md 第3段階) の mirror patch は source の
 * start/end (終日予定を含む) をそのまま写す必要があるため、専用に用意する。
 * 呼び出し元 (core/patch-event-raw.ts) が status を見て 401 リトライ判定とエラー変換を
 * 行うため、ここでは response をそのまま返し throw しない (他の google/*.ts と同じ層分担)。
 *
 * `sendUpdates` は**常にクエリに載せる** (2026-07-31)。2026-07-31 まではこの関数だけ
 * **クエリ文字列が一切無く**、patchEventTime に書いた根拠 (「ゲストのいる予定を patch すると
 * 誰にメールが飛ぶかは公式に文書化されていない既定次第」) がそのまま当てはまる穴が残っていた。
 * 値の決定は呼び出し側に強制し (PatchEventRawParams.sendUpdates が必須)、ここでは必ず
 * ?sendUpdates= を付けて送る。
 */
export async function patchEventRaw(
  fetchFn: typeof fetch,
  accessToken: string,
  params: PatchEventRawParams,
): Promise<Response> {
  const url = `${CALENDAR_BASE}/${encodeURIComponent(params.calendarId)}/events/${encodeURIComponent(params.eventId)}?sendUpdates=${params.sendUpdates}`;
  return fetchFn(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ start: params.start, end: params.end }),
  });
}
