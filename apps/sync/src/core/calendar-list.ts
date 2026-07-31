import type { CalendarListEntryDTO } from "@kichijitsu/shared";
import { GoogleApiError } from "./errors";
import { fetchCalendarList, parseCalendarList } from "../google/calendar-list";

/**
 * UserSyncDO.listCalendars が実装すべき依存先。他の core/*.ts (patch-event.ts 等) と同じ
 * { fetch, getAccessToken, forceRefreshAccessToken } 形なので、DO 側は buildEventWriteDeps を
 * 共用できる。
 */
export interface CalendarListCoreDeps {
  fetch: typeof fetch;
  /** キャッシュがあれば使い、無ければ (または期限切れなら) refresh_token から取り直す。 */
  getAccessToken: () => Promise<string>;
  /** キャッシュを無視して強制的にリフレッシュする (401 リトライ用)。 */
  forceRefreshAccessToken: () => Promise<string>;
}

/**
 * カレンダー一覧を取得する (`GET /api/calendars`)。他の *WithRetry と同じく、401 のみ 1 回だけ
 * 強制リフレッシュして同じリクエストを再試行する。
 *
 * **この 401 リトライは 2026-07-31 に足した** (振る舞いの変更)。それまで一覧取得は google 層で
 * 直接 GoogleApiError を投げており、kichijitsu の Google 呼び出しの中で唯一リトライが効かない
 * 経路だった ―― DO のトークンキャッシュが古い/失効している瞬間に当たると、他の同期は自力で
 * 回復するのに一覧だけが 401 で落ちる。カレンダー一覧は選択 UI の土台であり、さらに
 * defaultReminderMinutes (2026-07-31) を載せてリマインダー判定の依存先になったので、
 * ここだけ落ちる状態を残す理由が無くなった。
 *
 * 403/5xx や 401 リトライ後もなお失敗する場合は握りつぶさず GoogleApiError として伝播させる
 * (route 側は respondFromRpcResult で実 status のまま返す)。
 */
export async function listCalendarsWithRetry(
  deps: CalendarListCoreDeps,
): Promise<CalendarListEntryDTO[]> {
  let accessToken = await deps.getAccessToken();
  let retriedAuth = false;

  for (;;) {
    const response = await fetchCalendarList(deps.fetch, accessToken);

    if (response.status === 401 && !retriedAuth) {
      retriedAuth = true;
      accessToken = await deps.forceRefreshAccessToken();
      continue;
    }

    if (!response.ok) {
      throw new GoogleApiError(response.status, await response.text());
    }

    return parseCalendarList(response);
  }
}
