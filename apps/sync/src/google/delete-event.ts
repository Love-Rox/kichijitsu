import type { EventSendUpdates } from "@kichijitsu/shared";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";

export interface DeleteEventParams {
  calendarId: string;
  eventId: string;
  /**
   * ゲストへの通知 (2026-07-31)。**optional にしない** ―― patchEventTime と全く同じ理由で、
   * 省略できる形にした瞬間に「うっかり付け忘れて Google の未文書の既定に落ちる」が復活する。
   * 呼び出し側 (core/delete-event.ts / user-sync-do.ts の resolveSendUpdates) に必ず決めさせる。
   * 値の意味と選び方は shared の EventSendUpdates のコメント参照。
   */
  sendUpdates: EventSendUpdates;
}

/**
 * `events.delete` で予定を削除する。呼び出し元 (core/delete-event.ts) が status を見て
 * 401 リトライ判定・404 冪等成功・エラー変換を行うため、ここでは response をそのまま
 * 返し throw しない (patchEventTime と同じ層分担)。
 *
 * `sendUpdates` は**常にクエリに載せる** (2026-07-31)。events.delete にも
 * "Guests who should receive notifications about the deletion of the event" という
 * 同名のパラメータがあり、**省略時の既定は patch/update と同じく文書化されていない** ――
 * それまでここは一切付けておらず、ゲストのいる予定を削除したときにキャンセルのメールが
 * 全員へ飛ぶのか飛ばないのかが未文書の既定次第だった。
 *
 * **削除でも「メールを送らない」と「相手のカレンダーから消えない」は別物**である点が
 * 更新と同じで、そこがこの値の選び方の根拠になる ―― 主催者の削除はゲストの複製ごと
 * 取り消され ("This takes the event off your calendar, and off the calendars of everyone
 * else invited.")、その取り消しは status='cancelled' として同期で必ず届く
 * ("the result will always contain deleted entries, so that the clients get the chance to
 * remove them from storage")。sendUpdates が決めるのは**キャンセルの通知メールを誰に
 * 出すか**でしかない。ただし Google カレンダー以外を使うゲストはメールでしか取り消しを
 * 知れないため、`none` は使わない (shared の EventSendUpdates のコメント参照)。
 *
 * ゲストのいない予定では**どの値でも Google 側の結果は同じ** (知らせる相手がいない) ので、
 * 大多数を占める「自分だけの予定の削除」の挙動はこれで一切変わらない。
 */
export async function deleteEvent(
  fetchFn: typeof fetch,
  accessToken: string,
  params: DeleteEventParams,
): Promise<Response> {
  const url = `${CALENDAR_BASE}/${encodeURIComponent(params.calendarId)}/events/${encodeURIComponent(params.eventId)}?sendUpdates=${params.sendUpdates}`;
  return fetchFn(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
