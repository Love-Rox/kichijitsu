import type { RawAttendee } from "./rsvp-raw";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";

/**
 * ゲスト (参加者) の追加・削除 (2026-07-31) の Google 呼び出し層。read は RSVP と同じ
 * `getEventRaw` (rsvp-raw.ts) を使い回し、ここには**この経路だけの2つ**を置く:
 * 「主催者かどうかも一緒に読む」パースと、「sendUpdates=all を明示した attendees の patch」。
 */

interface RawEventGuestState {
  attendees?: RawAttendee[];
  /** event 直下の organizer。`self===true` なら、このカレンダーの持ち主が主催者 */
  organizer?: { self?: boolean };
}

/** getEventRaw のレスポンスから、差分適用に要る2つ (attendees と「自分が主催か」) を取り出す */
export interface EventGuestState {
  attendees: RawAttendee[];
  /** event.organizer.self === true か。false なら書き込みを行わない (core/guest-event.ts) */
  isOrganizer: boolean;
}

export async function parseEventGuestState(response: Response): Promise<EventGuestState> {
  const body = (await response.json()) as RawEventGuestState;
  return {
    attendees: body.attendees ?? [],
    isOrganizer: body.organizer?.self === true,
  };
}

/**
 * `events.patch` で attendees 配列全体を書き換える (全置換 ―― 公式に "Array fields, if
 * specified, overwrite the existing arrays; this discards any previous array elements")。
 *
 * ## なぜ sendUpdates を引数にせず all で固定するのか
 * 公式リファレンスは **sendUpdates を省略したときの既定を文書化していない**
 * (events.insert のページだけが "The default is false" と書いているが、これは3値の
 * enum に対する boolean の記述で、廃止された sendNotifications からの残骸)。
 * 選べる3値のうち、この操作で使ってよいのは all だけ:
 *
 *  - `none` … 公式に "Using the value `none` can have significant adverse effects,
 *    including events not syncing to external calendars or events being lost altogether
 *    for some users" と警告がある。具体的には (1) Google カレンダー以外を使うゲストは
 *    招待メール (iMIP) でしか予定を受け取れないので、送らなければ予定が届かない、
 *    (2) Google カレンダーのゲストでも「差出人を知っている場合のみ追加」等の設定なら
 *    メールから返事するまで予定が現れない。**これは「足したつもりが誰にも届いていない」
 *    そのもの**で、この機能が一番避けたい失敗。
 *  - `externalOnly` … 上の (1) は防げるが (2) は防げない。中途半端に安全なので採らない。
 *
 * 削除側も同じ理由で all: 外した相手に取り消しが届かなければ、その人のカレンダーには
 * 消えたはずの予定が残り続ける。
 *
 * したがって**メールが飛ぶことは前提**であり、UI 側はそれをボタンの文言に書く
 * (黙って送らない)。呼び出し元が status を見て 401 リトライ判定とエラー変換を行うため、
 * ここでは response をそのまま返し throw しない (他の google/*.ts と同じ層分担)。
 */
export async function patchGuestsRaw(
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
