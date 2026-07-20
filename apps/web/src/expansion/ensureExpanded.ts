import type { IDBPDatabase } from 'idb'
import type { KichijitsuDB } from '../db/database'
import {
  deleteOccurrencesByIds,
  getAllOccurrences,
  getAllOverrides,
  getAllSeries,
  getExpansionState,
  putOccurrences,
  setExpansionState,
} from '../db/database'
import { decideExpansionWindow } from './windowPolicy'
import type { OccurrenceStore } from '../store/occurrenceStore'
import type { Occurrence } from '../model/types'
import type { EventSeries, InstanceOverride } from '../model/series'
import type { ExpansionRequest, ExpansionResponse } from './expansion.worker'

/**
 * series+overrides の展開を担う Worker をモジュールスコープで1個だけ作り、
 * 使い回す。requestId でレスポンスを呼び出し元の Promise に対応付ける。
 */
let worker: Worker | undefined
let nextRequestId = 1
const pending = new Map<
  number,
  { resolve: (occurrences: Occurrence[]) => void; reject: (reason: unknown) => void }
>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./expansion.worker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', (event: MessageEvent<ExpansionResponse>) => {
      const { requestId, occurrences } = event.data
      const entry = pending.get(requestId)
      if (!entry) return
      pending.delete(requestId)
      entry.resolve(occurrences)
    })
    worker.addEventListener('error', (event) => {
      // どのリクエストで発生したエラーかは分からないため、保留中の全てを reject する
      for (const [id, entry] of pending) {
        entry.reject(event)
        pending.delete(id)
      }
    })
  }
  return worker
}

function runExpansion(
  series: EventSeries[],
  overrides: InstanceOverride[],
  fromMs: number,
  toMs: number,
): Promise<Occurrence[]> {
  const w = getWorker()
  const requestId = nextRequestId++
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject })
    const request: ExpansionRequest = { requestId, series, overrides, fromMs, toMs }
    w.postMessage(request)
  })
}

// 直列化: 前回呼び出しの完了(成功/失敗いずれも)を待ってから次の判定に入る
let chain: Promise<void> = Promise.resolve()

/**
 * 表示範囲 [visibleStartMs, visibleEndMs) を賄うのに十分な展開が
 * 済んでいるか確認し、不足していれば Worker で展開して IndexedDB に
 * bulk 書き込みしたのち store に反映する。
 *
 * 同時に複数回呼ばれても直列に処理する(前の展開が終わってから次の
 * needsExpand 判定を行う)ため、呼び出し側は await せず連打してよい。
 */
export function ensureExpanded(
  db: IDBPDatabase<KichijitsuDB>,
  store: OccurrenceStore,
  visibleStartMs: number,
  visibleEndMs: number,
): Promise<void> {
  const run = chain.then(() => doEnsureExpanded(db, store, visibleStartMs, visibleEndMs))
  chain = run.catch((err) => {
    console.error('ensureExpanded: expansion failed', err)
  })
  return run
}

async function doEnsureExpanded(
  db: IDBPDatabase<KichijitsuDB>,
  store: OccurrenceStore,
  visibleStartMs: number,
  visibleEndMs: number,
): Promise<void> {
  const state = await getExpansionState(db)
  const decision = decideExpansionWindow(visibleStartMs, visibleEndMs, state, Date.now())
  if (!decision.needsExpand) return

  const [series, overrides] = await Promise.all([getAllSeries(db), getAllOverrides(db)])
  const occurrences = await runExpansion(series, overrides, decision.fromMs, decision.toMs)

  await putOccurrences(db, occurrences)
  await setExpansionState(db, { expandedFromMs: decision.fromMs, expandedToMs: decision.toMs })
  // batch は remove+load の中間フレームを潰すのが主目的だが、load 単発でも
  // 呼び出し元 (reexpandCurrentWindow 等) の batch にネストして安全に畳まれるよう揃えておく
  await store.batch(() => {
    store.load(occurrences)
  })
}

/**
 * 保存済み ExpansionState の範囲で、全 series を無条件に展開し直す。
 *
 * ensureExpanded は「表示範囲が展開済み範囲の境界に近づいたときだけ」広げる
 * 増分ポリシーなので、sync で series の定義そのものが変わった場合
 * (RRULE 変更・EXDATE 追加・削除等) には対応できない。このため sync 適用後は
 * こちらを呼んで、既存範囲全体を強制的に再展開する。
 *
 * RRULE 変更等で消えた回が残骸として残らないよう、書き直す対象の series 由来
 * occurrence を先に削除してから新しい展開結果を put する。ensureExpanded と
 * 同じ直列化キュー (chain) を使うため、呼び出しがインターリーブしても安全。
 */
export function reexpandCurrentWindow(
  db: IDBPDatabase<KichijitsuDB>,
  store: OccurrenceStore,
): Promise<void> {
  const run = chain.then(() => doReexpand(db, store))
  chain = run.catch((err) => {
    console.error('reexpandCurrentWindow: failed', err)
  })
  return run
}

async function doReexpand(db: IDBPDatabase<KichijitsuDB>, store: OccurrenceStore): Promise<void> {
  const state = await getExpansionState(db)
  // まだ一度も展開していないなら再展開の必要はない (ensureExpanded に任せる)
  if (!state) return

  const [series, overrides, existingOccurrences] = await Promise.all([
    getAllSeries(db),
    getAllOverrides(db),
    getAllOccurrences(db),
  ])

  const seriesIds = new Set(series.map((s) => s.id))
  const staleIds = existingOccurrences
    .filter((o) => o.seriesId !== null && seriesIds.has(o.seriesId))
    .map((o) => o.id)
  await deleteOccurrencesByIds(db, staleIds)

  const occurrences = await runExpansion(series, overrides, state.expandedFromMs, state.expandedToMs)
  await putOccurrences(db, occurrences)

  // remove() → load() の間に古い回が消えた空フレームが描画されないよう、
  // 通知を1回にまとめる (store.load() は追加専用なので、置き換え前に古い
  // occurrence を明示的に消しておく必要がある: 消さないと RRULE 変更等で
  // 無くなった回が残骸として表示され続ける)
  await store.batch(() => {
    store.remove(staleIds)
    store.load(occurrences)
  })
}
