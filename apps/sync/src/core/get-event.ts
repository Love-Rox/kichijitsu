import type { GoogleEventDTO } from "@kichijitsu/shared";
import { GoogleApiError } from "./errors";
import { toGoogleEventDTO } from "./google-events";
import { getEvent } from "../google/get-event";

/**
 * UserSyncDO.getEvent が実装すべき依存先。他の core/*.ts と同じ
 * { fetch, getAccessToken, forceRefreshAccessToken } 形。
 */
export interface GetEventCoreDeps {
  fetch: typeof fetch;
  getAccessToken: () => Promise<string>;
  forceRefreshAccessToken: () => Promise<string>;
}

/**
 * `events.get` で予定1件を取り直す。孤児ミラー掃除 (docs/blocking.md「将来やるならこれ」) の
 * 削除前再検証専用 ―― クライアントの一覧 (GET /api/block-mirrors/orphans の結果) は走査後に
 * 古くなりうるので、POST /api/block-mirrors/cleanup は削除の直前に必ずこれで最新状態を
 * 取り直し、いま現在も孤児と言えるかを core/block-orphans.ts の classifyMirrorState に通す
 * (「ユーザーの予定を消す操作なので、クライアントの言い分を信用しない」原則。
 * routes/block-mirrors.ts 冒頭のコメント参照)。
 *
 * **404 は例外にせず null を返す**: 「クライアントの一覧が古く、既に消えている/存在しない
 * event id を指している」は失敗ではなく「もう削除する必要が無い」を意味するため。
 * deleteEventWithRetry (core/delete-event.ts) が 404 を成功扱いにするのとは逆に、こちらは
 * わざと "削除しなかった" 結果として呼び出し元に返す ―― 削除操作そのものを試みていない
 * (何もしていない) ことを failed 側の reason (not_found) として利用者に見せるため。
 *
 * 401 のみ 1 回だけ強制リフレッシュして同じリクエストを再試行する (他の *WithRetry と同じ方針)。
 * 403/5xx 等や 401 リトライ後もなお失敗する場合は握りつぶさず GoogleApiError として伝播させる。
 */
export async function getEventWithRetry(
  deps: GetEventCoreDeps,
  calendarId: string,
  eventId: string,
): Promise<GoogleEventDTO | null> {
  let accessToken = await deps.getAccessToken();
  let retriedAuth = false;

  for (;;) {
    const response = await getEvent(deps.fetch, accessToken, calendarId, eventId);

    if (response.status === 401 && !retriedAuth) {
      retriedAuth = true;
      accessToken = await deps.forceRefreshAccessToken();
      continue;
    }

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new GoogleApiError(response.status, await response.text());
    }

    const raw = await response.json();
    return toGoogleEventDTO(raw as Parameters<typeof toGoogleEventDTO>[0]);
  }
}
