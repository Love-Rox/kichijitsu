import type { GoogleEventDTO } from "@kichijitsu/shared";
import { GoogleApiError } from "./errors";
import { parseEventsListResponse, toGoogleEventDTO } from "./google-events";
import { fetchEventsInWindowPage } from "../google/list-events";

/**
 * UserSyncDO.listEventsInWindow が実装すべき依存先。他の core/*.ts と同じ考え方で、
 * DO storage / 実際の fetch を注入してロジックだけを単体テストできるようにする。
 */
export interface ListEventsInWindowCoreDeps {
  fetch: typeof fetch;
  /** キャッシュがあれば使い、無ければ (または期限切れなら) refresh_token から取り直す。 */
  getAccessToken: () => Promise<string>;
  /** キャッシュを無視して強制的にリフレッシュする (401 リトライ用)。 */
  forceRefreshAccessToken: () => Promise<string>;
}

/** RFC3339 の期間ウィンドウ。カレンダーブロック機能 (docs/blocking.md 第3段階) のリコンサイル対象範囲。 */
export interface ReconcileWindow {
  timeMin: string;
  timeMax: string;
}

// ウィンドウが広くページングが長引く懸念への安全弁。maxResults=250 × 20 = 5000 件まで
// 取得すれば個人〜招待制規模では十分実用的で、それでも超える場合はログを出して打ち切る
// (無限ページングでリコンサイルが詰まるのを防ぐ)。
const MAX_PAGES = 20;

/**
 * 期間指定で events.list を全ページ取得し、結合した GoogleEventDTO[] を返す。
 * sync.ts の runSync と同様、401 のみ 1 回だけ強制リフレッシュして同じページを再試行する。
 * それ以外のエラー (403/5xx 等) は握りつぶさず GoogleApiError として伝播させる。
 */
export async function listEventsInWindowWithRetry(
  deps: ListEventsInWindowCoreDeps,
  calendarId: string,
  window: ReconcileWindow,
): Promise<GoogleEventDTO[]> {
  const events: GoogleEventDTO[] = [];
  let pageToken: string | undefined;
  let accessToken = await deps.getAccessToken();
  let retriedAuth = false;
  let pageCount = 0;

  for (;;) {
    const response = await fetchEventsInWindowPage(deps.fetch, accessToken, calendarId, {
      timeMin: window.timeMin,
      timeMax: window.timeMax,
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
    events.push(...body.items.map(toGoogleEventDTO));
    pageCount++;

    if (body.nextPageToken) {
      if (pageCount >= MAX_PAGES) {
        console.warn(
          `listEventsInWindowWithRetry: reached ${MAX_PAGES} pages (${events.length} events) for calendar ${calendarId}, stopping pagination early`,
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
