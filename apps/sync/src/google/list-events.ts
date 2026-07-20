const EVENTS_LIST_BASE = "https://www.googleapis.com/calendar/v3/calendars";

export interface ListEventsInWindowPageParams {
  /** RFC3339 (どちらも必須。docs/blocking.md 第3段階のリコンサイル用ウィンドウ)。 */
  timeMin: string;
  timeMax: string;
  pageToken?: string;
}

/**
 * カレンダーブロック機能 (docs/blocking.md 第3段階) のリコンサイルが使う、期間指定の
 * events.list URL。core/google-events.ts の buildEventsListUrl (増分同期用、syncToken
 * ベース) とは別物 — こちらは syncToken を発行させない timeMin/timeMax 指定で、
 * singleEvents=true (繰り返し予定を展開済みインスタンスにする) かつ
 * showDeleted=false (キャンセル済みは最初から除く) で叩く。
 */
export function buildListEventsInWindowUrl(
  calendarId: string,
  params: ListEventsInWindowPageParams,
): string {
  const url = new URL(`${EVENTS_LIST_BASE}/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("showDeleted", "false");
  url.searchParams.set("timeMin", params.timeMin);
  url.searchParams.set("timeMax", params.timeMax);
  url.searchParams.set("maxResults", "250");
  url.searchParams.set("orderBy", "startTime");
  if (params.pageToken) {
    url.searchParams.set("pageToken", params.pageToken);
  }
  return url.toString();
}

/**
 * events.list を期間指定で 1 ページ分呼び出す。呼び出し元 (core/list-events.ts) が
 * status を見て 401 リトライ判定とエラー変換を行うため、ここでは response をそのまま
 * 返し throw しない (fetchEventsPage と同じ層分担)。
 */
export async function fetchEventsInWindowPage(
  fetchFn: typeof fetch,
  accessToken: string,
  calendarId: string,
  params: ListEventsInWindowPageParams,
): Promise<Response> {
  return fetchFn(buildListEventsInWindowUrl(calendarId, params), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
