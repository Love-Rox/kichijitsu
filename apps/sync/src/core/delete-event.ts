import { GoogleApiError } from './errors'
import { deleteEvent, type DeleteEventParams } from '../google/delete-event'

/**
 * UserSyncDO.deleteEvent が実装すべき依存先。core/patch-event.ts の PatchEventCoreDeps と
 * 同じ考え方で、DO storage / 実際の fetch を注入してロジックだけを単体テストできるようにする。
 */
export interface DeleteEventCoreDeps {
  fetch: typeof fetch
  /** キャッシュがあれば使い、無ければ (または期限切れなら) refresh_token から取り直す。 */
  getAccessToken: () => Promise<string>
  /** キャッシュを無視して強制的にリフレッシュする (401 リトライ用)。 */
  forceRefreshAccessToken: () => Promise<string>
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
export async function deleteEventWithRetry(deps: DeleteEventCoreDeps, params: DeleteEventParams): Promise<void> {
  let accessToken = await deps.getAccessToken()
  let retriedAuth = false

  for (;;) {
    const response = await deleteEvent(deps.fetch, accessToken, params)

    if (response.status === 401 && !retriedAuth) {
      retriedAuth = true
      accessToken = await deps.forceRefreshAccessToken()
      continue
    }

    if (response.status === 404) {
      return
    }

    if (!response.ok) {
      throw new GoogleApiError(response.status, await response.text())
    }

    return
  }
}
