const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";

export interface PatchEventTimeParams {
  calendarId: string;
  eventId: string;
  startMs: number;
  endMs: number;
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
 */
export async function patchEventTime(
  fetchFn: typeof fetch,
  accessToken: string,
  params: PatchEventTimeParams,
): Promise<Response> {
  const url = `${CALENDAR_BASE}/${encodeURIComponent(params.calendarId)}/events/${encodeURIComponent(params.eventId)}`;
  const start = params.isAllDay
    ? { date: toDateOnly(params.startMs, params.timeZone) }
    : { dateTime: toRfc3339Utc(params.startMs), timeZone: params.timeZone };
  const end = params.isAllDay
    ? { date: toDateOnly(params.endMs, params.timeZone) }
    : { dateTime: toRfc3339Utc(params.endMs), timeZone: params.timeZone };
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
