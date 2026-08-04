import { MIRROR_MARKER_KEY } from "../core/block-reconcile";

const EVENTS_LIST_BASE = "https://www.googleapis.com/calendar/v3/calendars";

export interface ScanMirrorEventsPageParams {
  pageToken?: string;
}

/**
 * 孤児ミラー掃除 (docs/blocking.md「将来やるならこれ」) の走査用 events.list URL。
 *
 * - `privateExtendedProperty=kichijitsuMirror%3D1`: Google 側で kichijitsuMirror=1 を持つ予定に
 *   絞り込む。公式リファレンス (Calendar API v3, events.list) の `privateExtendedProperty` に
 *   "Extended properties constraint specified as propertyName=value ... This parameter might be
 *   repeated multiple times" と明記されている。**このリポジトリには Google のテストアカウントが
 *   無く、実アカウントでの動作確認はしていない** (2026-08-04、ドキュメント記載のみで確認)。
 *   呼び出し元 (core/scan-mirror-events.ts) は取得した予定を toGoogleEventDTO 後にもう一度
 *   isMirrorEvent で確認する二重チェックにしてあるので、万一この絞り込みが期待通りに働かなくても
 *   孤児以外を誤って返すことはない (絞り込みが効かない場合は無関係な予定を多く取得して
 *   ページングが長引くだけで、安全側に倒れる)。
 * - `singleEvents=false`: mirror は繰り返しにならない (buildMirrorEventBody は1回きりの単発
 *   イベントしか作らない) が、リコンサイル用の buildListEventsInWindowUrl (singleEvents=true) とは
 *   別目的のクエリなので明示的に指定する
 * - timeMin/timeMax は付けない: 何ヶ月も前に解除・削除されて残った孤児も拾うため
 *   (docs/blocking.md「将来やるならこれ」)。全期間走査になりコストは高いが、この API は
 *   利用者が明示的に押す「掃除」ボタンからしか呼ばれない想定で、webhook/ポーリングのような
 *   高頻度経路ではない
 */
export function buildScanMirrorEventsUrl(
  calendarId: string,
  params: ScanMirrorEventsPageParams,
): string {
  const url = new URL(`${EVENTS_LIST_BASE}/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("privateExtendedProperty", `${MIRROR_MARKER_KEY}=1`);
  url.searchParams.set("singleEvents", "false");
  url.searchParams.set("maxResults", "250");
  if (params.pageToken) {
    url.searchParams.set("pageToken", params.pageToken);
  }
  return url.toString();
}

/**
 * events.list を 1 ページ分呼び出す。呼び出し元 (core/scan-mirror-events.ts) が status を見て
 * 401 リトライ判定とエラー変換を行うため、ここでは response をそのまま返し throw しない
 * (他の google/*.ts と同じ層分担)。
 */
export async function fetchScanMirrorEventsPage(
  fetchFn: typeof fetch,
  accessToken: string,
  calendarId: string,
  params: ScanMirrorEventsPageParams,
): Promise<Response> {
  return fetchFn(buildScanMirrorEventsUrl(calendarId, params), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
