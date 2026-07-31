import type { EventDeleteRequest } from "@kichijitsu/shared";
import { GoogleApiError } from "./errors";
import { deleteEvent, type DeleteEventParams } from "../google/delete-event";
import { SEND_UPDATES_VALUES } from "./patch-event";

/**
 * POST /api/event/delete のボディ検証 (2026-07-31)。それまでルートにインラインで書かれていた
 * 3つの非空チェックを、core/patch-event.ts の isValidEventPatchRequest と同じ
 * 「型ガード付き純関数」に出したもの ―― sendUpdates が増えて、値の集合まで見る必要が
 * 出たため (インラインの `!body?.x` の並びでは表現できない)。
 *
 * sendUpdates は未指定か "all" / "externalOnly"。**"none" は弾く** ―― 更新のときと
 * 同じ理由で、Google の enum には在るが kichijitsu は使わない値だから
 * (shared の EventSendUpdates のコメント参照)。未指定は resolveSendUpdates が既定を
 * 補うので 400 にはしない (sendUpdates を知らない旧クライアント互換)。
 */
export function isValidEventDeleteRequest(body: unknown): body is EventDeleteRequest {
  if (!body || typeof body !== "object") return false;
  const candidate = body as Record<string, unknown>;

  if (typeof candidate.accountId !== "string" || candidate.accountId.length === 0) return false;
  if (typeof candidate.calendarId !== "string" || candidate.calendarId.length === 0) return false;
  if (typeof candidate.eventId !== "string" || candidate.eventId.length === 0) return false;
  if (
    candidate.sendUpdates !== undefined &&
    !SEND_UPDATES_VALUES.includes(candidate.sendUpdates as string)
  ) {
    return false;
  }

  return true;
}

/**
 * UserSyncDO.deleteEvent が実装すべき依存先。core/patch-event.ts の PatchEventCoreDeps と
 * 同じ考え方で、DO storage / 実際の fetch を注入してロジックだけを単体テストできるようにする。
 */
export interface DeleteEventCoreDeps {
  fetch: typeof fetch;
  /** キャッシュがあれば使い、無ければ (または期限切れなら) refresh_token から取り直す。 */
  getAccessToken: () => Promise<string>;
  /** キャッシュを無視して強制的にリフレッシュする (401 リトライ用)。 */
  forceRefreshAccessToken: () => Promise<string>;
}

/**
 * 予定を Google Calendar から削除する。core/patch-event.ts の patchEventTimeWithRetry と
 * 同様、401 のみ 1 回だけ強制リフレッシュして同じリクエストを再試行する。
 *
 * 404 (既に削除済み) は成功として扱う — 削除は冪等な操作であり、クライアントが
 * リトライした場合や、webhook/ポーリング側の削除反映と競合した場合に「既に無い」ことは
 * 失敗ではなく目的達成 (もう存在しない) を意味するため。403/412/5xx や 401 リトライ後も
 * なお失敗する場合は握りつぶさず GoogleApiError として伝播させる — 呼び出し元 (route) が
 * これを 409 delete_failed 等にマップし、クライアントに楽観更新のロールバックを促す。
 *
 * 成功しても戻り値は無い (void)。正本は次の同期 (webhook/ポーリング → SSE 'changed' →
 * クライアントの /api/sync) で還流する設計であり、ここで Google の応答を整形して
 * クライアントへ返すことはしない。
 */
export async function deleteEventWithRetry(
  deps: DeleteEventCoreDeps,
  params: DeleteEventParams,
): Promise<void> {
  let accessToken = await deps.getAccessToken();
  let retriedAuth = false;

  for (;;) {
    const response = await deleteEvent(deps.fetch, accessToken, params);

    if (response.status === 401 && !retriedAuth) {
      retriedAuth = true;
      accessToken = await deps.forceRefreshAccessToken();
      continue;
    }

    if (response.status === 404) {
      return;
    }

    if (!response.ok) {
      throw new GoogleApiError(response.status, await response.text());
    }

    return;
  }
}
