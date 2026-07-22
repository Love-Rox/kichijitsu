import { GoogleApiError } from "./errors";
import { patchEventTime, type PatchEventTimeParams } from "../google/patch-event";

/**
 * UserSyncDO.patchEvent が実装すべき依存先。sync.ts の SyncCoreDeps と同じ考え方で、
 * DO storage / 実際の fetch を注入してロジックだけを単体テストできるようにする。
 */
export interface PatchEventCoreDeps {
  fetch: typeof fetch;
  /** キャッシュがあれば使い、無ければ (または期限切れなら) refresh_token から取り直す。 */
  getAccessToken: () => Promise<string>;
  /** キャッシュを無視して強制的にリフレッシュする (401 リトライ用)。 */
  forceRefreshAccessToken: () => Promise<string>;
}

/**
 * 予定の変更 (時刻 + 2026-07-22 以降は summary/location/description/isAllDay も可) を
 * Google へ書き戻す。sync.ts の runSync と同様、401 のみ 1 回だけ強制リフレッシュして
 * 同じリクエストを再試行する。404 (イベントなし) / 403 / 412 (前提条件の不一致) や
 * 401 リトライ後もなお失敗する場合は握りつぶさず GoogleApiError として伝播させる —
 * 呼び出し元 (route) がこれを 409 patch_failed 等にマップし、クライアントに楽観更新の
 * ロールバックを促す。
 *
 * params の summary/location/description/isAllDay の扱いは google/patch-event.ts の
 * patchEventTime のコメント参照 (指定したフィールドのみ PATCH body に含める)。
 *
 * 書き込みが成功しても戻り値は無い (void)。正本は次の同期 (Google からの
 * webhook/ポーリング → SSE 'changed' → クライアントの /api/sync) で還流する設計であり、
 * ここで Google の応答ボディを整形してクライアントへ返すことはしない。
 */
export async function patchEventTimeWithRetry(
  deps: PatchEventCoreDeps,
  params: PatchEventTimeParams,
): Promise<void> {
  let accessToken = await deps.getAccessToken();
  let retriedAuth = false;

  for (;;) {
    const response = await patchEventTime(deps.fetch, accessToken, params);

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
