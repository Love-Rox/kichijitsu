import type { WatchRequest } from '@kichijitsu/shared'
import type { RegisteredWatch } from '../google/watch'
import type { WatchRow } from './webhook'

export type { WatchRow } from './webhook'

/** POST /api/watch (enabled=true) で Google への登録に成功した後、D1 へ挿入する行を組み立てる。 */
export function buildWatchRow(
  request: Pick<WatchRequest, 'accountId' | 'calendarId'>,
  profileId: string,
  channelId: string,
  registered: RegisteredWatch,
  now: number,
): WatchRow {
  return {
    channel_id: channelId,
    resource_id: registered.resourceId,
    account_id: request.accountId,
    calendar_id: request.calendarId,
    profile_id: profileId,
    expiration_ms: registered.expiration,
    created_at: now,
  }
}

/** Cron 更新 (renewWatch) で古い行を置き換える、新しい channel_id の行を組み立てる。 */
export function buildRenewedWatchRow(oldRow: WatchRow, channelId: string, registered: RegisteredWatch, now: number): WatchRow {
  return {
    channel_id: channelId,
    resource_id: registered.resourceId,
    account_id: oldRow.account_id,
    calendar_id: oldRow.calendar_id,
    profile_id: oldRow.profile_id,
    expiration_ms: registered.expiration,
    created_at: now,
  }
}

const DEFAULT_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Cron (6時間おき) が再 watch すべき行を選別する。
 * `expiration_ms` が null (Google が expiration を返さなかった watch) は対象外にする —
 * 期限が分からない以上、安全側に倒して triggerしない (次の Cron 実行まで待つ)。
 */
export function selectWatchesNeedingRenewal(
  watches: WatchRow[],
  now: number,
  renewalWindowMs: number = DEFAULT_RENEWAL_WINDOW_MS,
): WatchRow[] {
  return watches.filter((w) => w.expiration_ms !== null && w.expiration_ms - now <= renewalWindowMs)
}
