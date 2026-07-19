import { openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'
import type { Occurrence } from '../model/types'
import type { EventSeries, InstanceOverride } from '../model/series'
import type { ExpansionState } from '../expansion/windowPolicy'
import { DAY_MS } from '../expansion/windowPolicy'

/**
 * IndexedDB (idb ラッパー) の薄いアクセス層。UI/展開ロジックはこれ経由でのみ
 * 永続化に触れる。スキーマ変更は必ずここの version を上げて upgrade で行う。
 */

export interface HiyoriDB extends DBSchema {
  occurrences: {
    key: string
    value: Occurrence
    indexes: { startMs: number }
  }
  series: {
    key: string
    value: EventSeries
  }
  overrides: {
    key: string
    value: InstanceOverride
  }
  meta: {
    key: string
    value: ExpansionState
  }
}

const DB_NAME = 'hiyori'
const DB_VERSION = 1
const META_EXPANSION_KEY = 'expansion'

let dbPromise: Promise<IDBPDatabase<HiyoriDB>> | undefined

/** DB 接続を開く(メモ化: 同一プロセス内では1接続を使い回す) */
export async function openHiyoriDB(): Promise<IDBPDatabase<HiyoriDB>> {
  if (!dbPromise) {
    dbPromise = openDB<HiyoriDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('occurrences')) {
          const store = db.createObjectStore('occurrences', { keyPath: 'id' })
          store.createIndex('startMs', 'startMs')
        }
        if (!db.objectStoreNames.contains('series')) {
          db.createObjectStore('series', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('overrides')) {
          db.createObjectStore('overrides', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('meta')) {
          // out-of-line key: put 時に key を明示して渡す (keyPath なし)
          db.createObjectStore('meta')
        }
      },
    })
  }
  return dbPromise
}

export async function getAllSeries(db: IDBPDatabase<HiyoriDB>): Promise<EventSeries[]> {
  return db.getAll('series')
}

export async function putSeries(
  db: IDBPDatabase<HiyoriDB>,
  series: EventSeries | EventSeries[],
): Promise<void> {
  const list = Array.isArray(series) ? series : [series]
  const tx = db.transaction('series', 'readwrite')
  await Promise.all([...list.map((s) => tx.store.put(s)), tx.done])
}

export async function getAllOverrides(db: IDBPDatabase<HiyoriDB>): Promise<InstanceOverride[]> {
  return db.getAll('overrides')
}

export async function putOverride(
  db: IDBPDatabase<HiyoriDB>,
  override: InstanceOverride,
): Promise<void> {
  await db.put('overrides', override)
}

export async function deleteSeriesByIds(db: IDBPDatabase<HiyoriDB>, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const tx = db.transaction('series', 'readwrite')
  await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done])
}

export async function deleteOverridesByIds(db: IDBPDatabase<HiyoriDB>, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const tx = db.transaction('overrides', 'readwrite')
  await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done])
}

/** 単一トランザクションでの bulk 書き込み */
export async function putOccurrences(
  db: IDBPDatabase<HiyoriDB>,
  occurrences: Occurrence[],
): Promise<void> {
  const tx = db.transaction('occurrences', 'readwrite')
  await Promise.all([...occurrences.map((o) => tx.store.put(o)), tx.done])
}

export async function putOccurrence(
  db: IDBPDatabase<HiyoriDB>,
  occurrence: Occurrence,
): Promise<void> {
  await db.put('occurrences', occurrence)
}

export async function getAllOccurrences(db: IDBPDatabase<HiyoriDB>): Promise<Occurrence[]> {
  return db.getAll('occurrences')
}

export async function deleteOccurrencesByIds(
  db: IDBPDatabase<HiyoriDB>,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return
  const tx = db.transaction('occurrences', 'readwrite')
  await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done])
}

/**
 * [fromMs, toMs) に重なる occurrence を返す。
 * startMs インデックスの範囲クエリでは「開始が fromMs より前だが範囲に食い込む」
 * イベントを取りこぼすため、fromMs - 24h まで下限を広げてから拾い、
 * 最後に実際の重なり判定で絞り込む。
 */
export async function getOccurrencesBetween(
  db: IDBPDatabase<HiyoriDB>,
  fromMs: number,
  toMs: number,
): Promise<Occurrence[]> {
  const lowerBound = fromMs - DAY_MS
  const range = IDBKeyRange.bound(lowerBound, toMs, false, true)
  const candidates = await db.getAllFromIndex('occurrences', 'startMs', range)
  return candidates.filter((o) => o.startMs < toMs && o.endMs > fromMs)
}

export async function getExpansionState(
  db: IDBPDatabase<HiyoriDB>,
): Promise<ExpansionState | null> {
  const state = await db.get('meta', META_EXPANSION_KEY)
  return state ?? null
}

export async function setExpansionState(
  db: IDBPDatabase<HiyoriDB>,
  state: ExpansionState,
): Promise<void> {
  await db.put('meta', state, META_EXPANSION_KEY)
}

export async function countSeries(db: IDBPDatabase<HiyoriDB>): Promise<number> {
  return db.count('series')
}
