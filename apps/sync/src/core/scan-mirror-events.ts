import type { GoogleEventDTO } from "@kichijitsu/shared";
import { GoogleApiError } from "./errors";
import { isMirrorEvent } from "./block-reconcile";
import { parseEventsListResponse, toGoogleEventDTO } from "./google-events";
import { fetchScanMirrorEventsPage } from "../google/scan-mirror-events";

/**
 * UserSyncDO.scanMirrorEvents が実装すべき依存先。他の core/*.ts (list-events.ts 等) と同じ
 * { fetch, getAccessToken, forceRefreshAccessToken } 形なので、DO 側は buildEventWriteDeps を
 * 共用できる。
 */
export interface ScanMirrorEventsCoreDeps {
  fetch: typeof fetch;
  getAccessToken: () => Promise<string>;
  forceRefreshAccessToken: () => Promise<string>;
}

// timeMin/timeMax 無しの全期間走査のため、予定の多いカレンダーではページ数が伸びうる。
// core/list-events.ts の listEventsInWindowWithRetry と同じ安全弁の考え方で上限を設け、
// 超えたらログを出して打ち切る (無限ページングで掃除 API が詰まるのを防ぐ)。
const MAX_PAGES = 20;

/**
 * 孤児ミラー掃除 (docs/blocking.md「将来やるならこれ」) の走査本体:
 * 指定カレンダーの kichijitsuMirror=1 な予定を、ページングを内部で吸収して全件返す。
 *
 * privateExtendedProperty による絞り込みが実際に効くかは実アカウントで検証していない
 * (google/scan-mirror-events.ts のコメント参照) ため、取得した予定は isMirrorEvent で
 * もう一度確認してから返す ―― Google 側の絞り込みを信用しきらない二重チェック。
 *
 * 401 のみ 1 回だけ強制リフレッシュして同じページを再試行する (他の *WithRetry と同じ方針)。
 * それ以外のエラー (403/5xx 等) は握りつぶさず GoogleApiError として伝播させる。
 */
export async function scanMirrorEventsWithRetry(
  deps: ScanMirrorEventsCoreDeps,
  calendarId: string,
): Promise<GoogleEventDTO[]> {
  const events: GoogleEventDTO[] = [];
  let pageToken: string | undefined;
  let accessToken = await deps.getAccessToken();
  let retriedAuth = false;
  let pageCount = 0;

  for (;;) {
    const response = await fetchScanMirrorEventsPage(deps.fetch, accessToken, calendarId, {
      pageToken,
    });

    if (response.status === 401 && !retriedAuth) {
      retriedAuth = true;
      accessToken = await deps.forceRefreshAccessToken();
      continue;
    }

    if (!response.ok) {
      throw new GoogleApiError(response.status, await response.text());
    }

    const body = await parseEventsListResponse(response);
    for (const raw of body.items) {
      const event = toGoogleEventDTO(raw);
      // 上記コメントの二重チェック: Google 側の絞り込みを信用しきらず、ここでも確認する。
      if (isMirrorEvent(event)) {
        events.push(event);
      }
    }
    pageCount++;

    if (body.nextPageToken) {
      if (pageCount >= MAX_PAGES) {
        console.warn(
          `scanMirrorEventsWithRetry: reached ${MAX_PAGES} pages (${events.length} mirror events so far) for calendar ${calendarId}, stopping pagination early`,
        );
        break;
      }
      pageToken = body.nextPageToken;
      continue;
    }

    break;
  }

  return events;
}
