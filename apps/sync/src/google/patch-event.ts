import type { EventSendUpdates } from "@kichijitsu/shared";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";

export interface PatchEventTimeParams {
  calendarId: string;
  eventId: string;
  /**
   * 変更後の時間帯。**両方 undefined なら start/end を PATCH body に含めない**
   * (2026-07-30、繰り返し予定の適用範囲) ―― Google 側の時刻はそのまま保たれる。
   * 繰り返し予定の親を「内容だけ」書き換えるときに、DTSTART を無用に書き直さないため。
   * 片方だけ指定するのは呼び出し側のバグ (ルートの isValidEventPatchRequest が弾く)。
   */
  startMs?: number;
  endMs?: number;
  /** クライアントの IANA タイムゾーン。dateTime と併記して Google に渡す (isAllDay の date 変換にも使う)。 */
  timeZone: string;
  /**
   * true なら start/end を `date` (終日) 形式で送る (2026-07-22 全項目編集)。
   * false/未指定は従来どおり `dateTime` (時刻予定)。
   */
  isAllDay?: boolean;
  /**
   * 指定時のみ PATCH body に含める (undefined は「未指定」= Google 側で既存値を保持)。
   * 空文字は「クリア」の意図として明示的に送る (2026-07-22 全項目編集)。
   */
  summary?: string;
  location?: string;
  description?: string;
  /**
   * ゲストへの通知 (2026-07-31)。**optional にしない** ―― 省略できる形にした瞬間に
   * 「うっかり付け忘れて Google の未文書の既定に落ちる」が復活するため、
   * 呼び出し側 (core/patch-event.ts の resolveSendUpdates) に必ず決めさせる。
   * 値の意味と選び方は shared の EventSendUpdates のコメント参照。
   */
  sendUpdates: EventSendUpdates;
}

/**
 * epoch ms を RFC3339 (UTC, "Z" 付き) に変換する。
 * Google Calendar API の start/end.dateTime は UTC オフセット付き RFC3339 であれば
 * よく、`date-fns-tz` 等でクライアントのローカル時刻表記に組み立て直す必要はない —
 * timeZone フィールドを併記すれば、表示や繰り返し予定 (RRULE) の計算はそちらを
 * 正として Google 側が扱ってくれるため、dateTime 自体は常に UTC 表記
 * (`Date#toISOString()`) で送って問題ない。
 */
export function toRfc3339Utc(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * epoch ms を指定 IANA タイムゾーンでの日付 (YYYY-MM-DD) に変換する。終日予定の
 * `date` フィールド用 (2026-07-22 全項目編集、isAllDay)。
 * en-CA ロケールの日付書式が ISO と同じ YYYY-MM-DD 順になることを利用する
 * (Intl.DateTimeFormat に "YYYY-MM-DD" 直接指定のフォーマットは無いため)。
 */
export function toDateOnly(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/**
 * `events.patch` で start/end (時刻 or 終日) と、指定されたフィールド (summary/location/
 * description) を書き換える。Google の events.patch は指定した top-level フィールドのみを
 * マージ更新するため、body に含めなかったフィールドは既存値のまま保持される —
 * summary/location/description が undefined の場合は body にキー自体を含めない
 * (JSON.stringify は undefined な値のプロパティを自動的に省略する、という挙動をそのまま
 * 利用している。空文字は「クリア」なので undefined と区別してそのまま送る)。
 * 呼び出し元 (core/patch-event.ts) が status を見て 401 リトライ判定とエラー変換を
 * 行うため、ここでは response をそのまま返し throw しない (fetchEventsPage と同じ層分担)。
 *
 * startMs/endMs が未指定なら start/end のキー自体を組み立てない (undefined を渡して
 * JSON.stringify に省略させる) ―― summary 等と同じ流儀で「時刻には触らない」を表現する。
 * 時刻を送る場合は必ず timeZone を併記する: Google Calendar API は**繰り返し予定では
 * start/end の timeZone を必須**としており (展開に使うため)、親イベントを patch する
 * 「すべての予定」経路ではこれが効いてくる。
 *
 * `sendUpdates` は**常にクエリに載せる** (2026-07-31)。この経路は参加者を触らないが、
 * 公式の説明は "Guests who should receive notifications about the event update
 * (for example, title changes, etc.)" ―― タイトルや時刻の変更でもゲストにメールが飛びうる。
 * それまでここは sendUpdates を一切付けておらず、**ゲストのいる予定をドラッグで動かしたら
 * 全員にメールが飛ぶのかどうかが、公式に文書化されていない既定次第**という状態だった。
 * 利用者に見える挙動を未文書の既定に委ねないため、値の決定は呼び出し側に強制し
 * (PatchEventTimeParams.sendUpdates が必須)、ここでは必ず ?sendUpdates= を付けて送る。
 * ゲストのいない予定では**どの値でも Google 側の結果は同じ** (知らせる相手がいない) ので、
 * 大多数を占める「自分だけの予定の編集・移動」の挙動はこれで一切変わらない。
 */
export async function patchEventTime(
  fetchFn: typeof fetch,
  accessToken: string,
  params: PatchEventTimeParams,
): Promise<Response> {
  const url = `${CALENDAR_BASE}/${encodeURIComponent(params.calendarId)}/events/${encodeURIComponent(params.eventId)}?sendUpdates=${params.sendUpdates}`;
  const { startMs, endMs } = params;
  const start =
    startMs === undefined
      ? undefined
      : params.isAllDay
        ? { date: toDateOnly(startMs, params.timeZone) }
        : { dateTime: toRfc3339Utc(startMs), timeZone: params.timeZone };
  const end =
    endMs === undefined
      ? undefined
      : params.isAllDay
        ? { date: toDateOnly(endMs, params.timeZone) }
        : { dateTime: toRfc3339Utc(endMs), timeZone: params.timeZone };
  return fetchFn(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      start,
      end,
      summary: params.summary,
      location: params.location,
      description: params.description,
    }),
  });
}
