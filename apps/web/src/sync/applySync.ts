import type { IDBPDatabase } from 'idb'
import type { SyncResponse } from '@kichijitsu/shared'
import type { KichijitsuDB } from '../db/database'
import {
  deleteOccurrencesByIds,
  deleteOverridesByIds,
  deleteSeriesByIds,
  getAllOccurrences,
  getAllOverrides,
  getAllSeries,
  getExpansionState,
  getOccurrencesBetween,
  putOccurrences,
  putOverride,
  putSeries,
} from '../db/database'
import { reexpandCurrentWindow } from '../expansion/ensureExpanded'
import type { OccurrenceStore } from '../store/occurrenceStore'
import { mapGoogleEvents, type MapGoogleContext } from './mapGoogle'

/** deleteGoogleData のフィルタに渡す、削除対象を絞り込むための occurrence/series のキー */
export interface GoogleDataKey {
  accountId?: string
  calendarId?: string
}

/**
 * IndexedDB 上の source==='google' な series/overrides/occurrences を削除する。
 * filter を省略すると google 由来のデータを全て削除する(引数無しで全アカウント
 * 分をまとめて消したいケース向け)。マルチアカウント対応(2026-07-19)により、
 * 通常は (accountId, calendarId) で絞り込んだ filter を渡して使う:
 * - 全同期時のローカルレプリカ再構築 (applySyncResponse の isFullSync 分岐、
 *   対象 (accountId, calendarId) のみ)
 * - カレンダーの選択解除 (App.tsx、対象 (accountId, calendarId) のみ)
 * - アカウント単位の連携解除 (App.tsx、対象 accountId の全カレンダー)
 *
 * 戻り値の deletedOccurrenceIds は、呼び出し側が OccurrenceStore.remove() で
 * store からも消すために使う(store.load() は追加専用で削除できないため)。
 */
export async function deleteGoogleData(
  db: IDBPDatabase<KichijitsuDB>,
  filter?: (key: GoogleDataKey) => boolean,
): Promise<{ deletedOccurrenceIds: string[] }> {
  const [existingSeries, existingOverrides, existingOccurrences] = await Promise.all([
    getAllSeries(db),
    getAllOverrides(db),
    getAllOccurrences(db),
  ])
  const matches = (accountId?: string, calendarId?: string): boolean =>
    filter ? filter({ accountId, calendarId }) : true

  const googleSeriesIds = new Set(
    existingSeries
      .filter((s) => s.source === 'google' && matches(s.accountId, s.calendarId))
      .map((s) => s.id),
  )
  const googleOverrideIds = existingOverrides
    .filter((o) => googleSeriesIds.has(o.seriesId))
    .map((o) => o.id)
  const googleOccurrenceIds = existingOccurrences
    .filter((o) => o.source === 'google' && matches(o.accountId, o.calendarId))
    .map((o) => o.id)

  await Promise.all([
    deleteSeriesByIds(db, [...googleSeriesIds]),
    deleteOverridesByIds(db, googleOverrideIds),
    deleteOccurrencesByIds(db, googleOccurrenceIds),
  ])

  return { deletedOccurrenceIds: googleOccurrenceIds }
}

/**
 * apps/sync から受け取った SyncResponse (1つの (accountId, calendarId) ぶん) を
 * IndexedDB に適用し、store に反映する。
 *
 * isFullSync の場合は「この (accountId, calendarId) の」既存 google データだけを
 * 削除してから書き直す(サーバーは差分の起点 = syncToken しか保持しないため、
 * 全同期時はそのカレンダーのローカルレプリカを作り直すのが安全。他カレンダーの
 * データは巻き込まない)。
 */
export async function applySyncResponse(
  db: IDBPDatabase<KichijitsuDB>,
  store: OccurrenceStore,
  res: SyncResponse,
  ctx: MapGoogleContext,
): Promise<void> {
  if (res.isFullSync) {
    const { deletedOccurrenceIds } = await deleteGoogleData(
      db,
      (k) => k.accountId === ctx.accountId && k.calendarId === ctx.calendarId,
    )
    store.remove(deletedOccurrenceIds)
  }

  const mapped = mapGoogleEvents(res.events, ctx)

  await putSeries(db, mapped.series)
  await Promise.all(mapped.overrides.map((o) => putOverride(db, o)))
  await putOccurrences(db, mapped.singles)
  await deleteOccurrencesByIds(db, mapped.deletedSingleIds)
  store.remove(mapped.deletedSingleIds)

  // series 定義そのものが変わっている可能性があるため、展開済み範囲を無条件に作り直す
  await reexpandCurrentWindow(db, store)

  const state = await getExpansionState(db)
  if (state) {
    const all = await getOccurrencesBetween(db, state.expandedFromMs, state.expandedToMs)
    store.load(all)
  }
}
