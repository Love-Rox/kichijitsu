import type { IDBPDatabase } from 'idb'
import type { SyncResponse } from '@hiyori/shared'
import type { HiyoriDB } from '../db/database'
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
import { mapGoogleEvents } from './mapGoogle'

/**
 * apps/sync から受け取った SyncResponse を IndexedDB に適用し、store に反映する。
 *
 * isFullSync の場合は既存の source==='google' なデータを全削除してから
 * 書き直す(サーバーは差分の起点 = syncToken しか保持しないため、全同期時は
 * ローカルレプリカを作り直すのが安全)。
 */
export async function applySyncResponse(
  db: IDBPDatabase<HiyoriDB>,
  store: OccurrenceStore,
  res: SyncResponse,
): Promise<void> {
  if (res.isFullSync) {
    const [existingSeries, existingOverrides, existingOccurrences] = await Promise.all([
      getAllSeries(db),
      getAllOverrides(db),
      getAllOccurrences(db),
    ])
    const googleSeriesIds = new Set(
      existingSeries.filter((s) => s.source === 'google').map((s) => s.id),
    )
    const googleOverrideIds = existingOverrides
      .filter((o) => googleSeriesIds.has(o.seriesId))
      .map((o) => o.id)
    const googleOccurrenceIds = existingOccurrences
      .filter((o) => o.source === 'google')
      .map((o) => o.id)

    await Promise.all([
      deleteSeriesByIds(db, [...googleSeriesIds]),
      deleteOverridesByIds(db, googleOverrideIds),
      deleteOccurrencesByIds(db, googleOccurrenceIds),
    ])
  }

  const mapped = mapGoogleEvents(res.events)

  await putSeries(db, mapped.series)
  await Promise.all(mapped.overrides.map((o) => putOverride(db, o)))
  await putOccurrences(db, mapped.singles)
  await deleteOccurrencesByIds(db, mapped.deletedSingleIds)

  // series 定義そのものが変わっている可能性があるため、展開済み範囲を無条件に作り直す
  await reexpandCurrentWindow(db, store)

  const state = await getExpansionState(db)
  if (state) {
    const all = await getOccurrencesBetween(db, state.expandedFromMs, state.expandedToMs)
    store.load(all)
  }
}
