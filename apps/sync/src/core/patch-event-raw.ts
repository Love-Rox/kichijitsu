import { GoogleApiError } from "./errors";
import { patchEventRaw, type PatchEventRawParams } from "../google/patch-event-raw";

/**
 * UserSyncDO.patchEventRaw が実装すべき依存先。core/patch-event.ts の PatchEventCoreDeps と
 * 同じ考え方で、DO storage / 実際の fetch を注入してロジックだけを単体テストできるようにする。
 */
export interface PatchEventRawCoreDeps {
  fetch: typeof fetch;
  /** キャッシュがあれば使い、無ければ (または期限切れなら) refresh_token から取り直す。 */
  getAccessToken: () => Promise<string>;
  /** キャッシュを無視して強制的にリフレッシュする (401 リトライ用)。 */
  forceRefreshAccessToken: () => Promise<string>;
}

/**
 * カレンダーブロック機能 (docs/blocking.md 第3段階) の mirror イベントの start/end を
 * source の値のまま (終日予定含む) 書き換える。core/patch-event.ts の
 * patchEventTimeWithRetry (epoch ms + timeZone、時刻予定限定) とは別物として用意した —
 * mirror は source の start/end (dateTime か date のいずれか) をそのまま写す必要があり、
 * all-day の mirror も正しく patch できることを優先するため。401 のみ 1 回だけ強制
 * リフレッシュして同じリクエストを再試行する。それ以外のエラーは握りつぶさず
 * GoogleApiError として伝播させる。
 *
 * 書き込みが成功しても戻り値は無い (void)。正本は次の同期で還流する設計であり、ここで
 * Google の応答をクライアントへそのまま返すことはしない (他の patch 系と同じ方針)。
 */
export async function patchEventRawWithRetry(
  deps: PatchEventRawCoreDeps,
  params: PatchEventRawParams,
): Promise<void> {
  let accessToken = await deps.getAccessToken();
  let retriedAuth = false;

  for (;;) {
    const response = await patchEventRaw(deps.fetch, accessToken, params);

    if (response.status === 401 && !retriedAuth) {
      retriedAuth = true;
      accessToken = await deps.forceRefreshAccessToken();
      continue;
    }

    if (!response.ok) {
      throw new GoogleApiError(response.status, await response.text());
    }

    return;
  }
}
