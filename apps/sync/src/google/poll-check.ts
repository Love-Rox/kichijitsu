import { GoogleApiError } from "../core/errors";

const EVENTS_LIST_BASE = "https://www.googleapis.com/calendar/v3/calendars";

/**
 * ポーリングフォールバック (UserSyncDO の alarm) 用の軽量な「変化があったか」チェック。
 * syncToken を消費しない (syncToken パラメータを一切送らない) ので、通常の増分同期と
 * 独立して安全に呼べる。
 *
 * `orderBy=updated&maxResults=1` で「最後に更新されたイベント」を安く取る案も検討したが、
 * Google Calendar API の orderBy は昇順 (古い→新しい) 固定でソート方向を選べないため、
 * `maxResults=1` と組み合わせると「一番古い」イベントしか取れず目的に合わない
 * (かつ orderBy の利用には singleEvents=true が必須という制約もあり、繰り返し予定の
 * 展開コストも余分にかかる)。
 *
 * 代わりに `updatedMin` を "ソート" ではなく "フィルタ" として使い、「前回チェック時刻より
 * 後に更新されたイベントが1件でもあるか」だけを見る存在チェックにする。`maxResults=1` で
 * 実際に1件でも当たれば十分 (中身は見ない)。
 */
export function buildPollCheckUrl(calendarId: string, updatedMinIso: string): string {
  const url = new URL(`${EVENTS_LIST_BASE}/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("updatedMin", updatedMinIso);
  url.searchParams.set("maxResults", "1");
  url.searchParams.set("showDeleted", "true"); // 削除も「変化」として検知する
  url.searchParams.set("fields", "items(id)");
  return url.toString();
}

export async function hasUpdatesSince(
  fetchFn: typeof fetch,
  accessToken: string,
  calendarId: string,
  updatedMinIso: string,
): Promise<boolean> {
  const response = await fetchFn(buildPollCheckUrl(calendarId, updatedMinIso), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new GoogleApiError(response.status, await response.text());
  }
  const data = (await response.json()) as { items?: Array<{ id: string }> };
  return (data.items?.length ?? 0) > 0;
}
