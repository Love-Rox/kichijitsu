import type { SyncResponse } from '@kichijitsu/shared'
import { GoogleApiError, SyncTokenExpiredError } from './errors'
import { fetchEventsPage, parseEventsListResponse, toGoogleEventDTO } from './google-events'

/**
 * UserSyncDO が実装すべき依存先。DO storage / D1 / 実際の fetch を注入することで
 * DO 本体に依存せずロジックだけを単体テストできるようにする。
 */
export interface SyncCoreDeps {
  fetch: typeof fetch
  /** キャッシュがあれば使い、無ければ (または期限切れなら) refresh_token から取り直す。 */
  getAccessToken: () => Promise<string>
  /** キャッシュを無視して強制的にリフレッシュする (401 リトライ用)。 */
  forceRefreshAccessToken: () => Promise<string>
  getSyncToken: (calendarId: string) => Promise<string | null>
  /** null を渡すと syncToken を破棄する (410 フォールバック時)。 */
  saveSyncToken: (calendarId: string, syncToken: string | null) => Promise<void>
}

export async function syncCalendar(deps: SyncCoreDeps, calendarId: string): Promise<SyncResponse> {
  const syncToken = await deps.getSyncToken(calendarId)

  try {
    return await runSync(deps, calendarId, syncToken)
  } catch (err) {
    if (err instanceof SyncTokenExpiredError) {
      // syncToken 失効 (410) → 破棄して全同期にフォールバック
      await deps.saveSyncToken(calendarId, null)
      return await runSync(deps, calendarId, null)
    }
    throw err
  }
}

async function runSync(
  deps: SyncCoreDeps,
  calendarId: string,
  syncToken: string | null,
): Promise<SyncResponse> {
  const isFullSync = syncToken === null
  const events: SyncResponse['events'] = []
  let pageToken: string | undefined
  let nextSyncToken: string | undefined
  let accessToken = await deps.getAccessToken()
  let retriedAuth = false

  for (;;) {
    const response = await fetchEventsPage(deps.fetch, accessToken, calendarId, {
      syncToken: syncToken ?? undefined,
      pageToken,
    })

    if (response.status === 401 && !retriedAuth) {
      // アクセストークン期限切れ → 1 回だけリフレッシュして同じページを再試行
      retriedAuth = true
      accessToken = await deps.forceRefreshAccessToken()
      continue
    }

    if (response.status === 410) {
      throw new SyncTokenExpiredError()
    }

    if (!response.ok) {
      // 401 の再試行後もなお失敗 / 429 / 5xx など。握りつぶさずそのまま伝播する。
      throw new GoogleApiError(response.status, await response.text())
    }

    const body = await parseEventsListResponse(response)
    events.push(...body.items.map(toGoogleEventDTO))

    if (body.nextPageToken) {
      pageToken = body.nextPageToken
      continue
    }

    nextSyncToken = body.nextSyncToken
    break
  }

  await deps.saveSyncToken(calendarId, nextSyncToken ?? null)

  return { isFullSync, events }
}
