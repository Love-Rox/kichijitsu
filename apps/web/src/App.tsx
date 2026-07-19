import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Temporal } from '@js-temporal/polyfill'
import type { IDBPDatabase } from 'idb'
import { WeekGrid } from './components/WeekGrid'
import { generateDummyOccurrences, generateDummyOverrides, generateDummySeries } from './model/dummy'
import { instanceId } from './model/series'
import type { Occurrence } from './model/types'
import { OccurrenceStore } from './store/occurrenceStore'
import {
  countSeries,
  getExpansionState,
  getOccurrencesBetween,
  openHiyoriDB,
  putOccurrence,
  putOccurrences,
  putOverride,
  putSeries,
  type HiyoriDB,
} from './db/database'
import { ensureExpanded } from './expansion/ensureExpanded'
import './App.css'

/** 指定日を含む週の月曜日 */
function mondayOf(date: Temporal.PlainDate): Temporal.PlainDate {
  return date.subtract({ days: date.dayOfWeek - 1 })
}

/** 週 [weekStart, weekStart+7日) の epoch ms 範囲(timeZone の壁時計基準) */
function weekRangeMs(weekStart: Temporal.PlainDate, timeZone: string): { fromMs: number; toMs: number } {
  const fromMs = weekStart.toZonedDateTime({ timeZone }).epochMilliseconds
  const toMs = weekStart.add({ days: 7 }).toZonedDateTime({ timeZone }).epochMilliseconds
  return { fromMs, toMs }
}

// 週切替アニメーション(WeekGrid 側 SLIDE_MS=200ms)より少し長めに連打をロックする
const NAV_LOCK_MS = 220

function App() {
  const timeZone = useMemo(() => Temporal.Now.timeZoneId(), [])
  const [weekStart, setWeekStart] = useState(() => mondayOf(Temporal.Now.plainDateISO()))
  const navLockRef = useRef(false)

  const store = useMemo(() => new OccurrenceStore(), [])
  const [db, setDb] = useState<IDBPDatabase<HiyoriDB> | null>(null)

  // 起動時: DB を開く → 初回のみ dummy データをシード → 表示週ぶんを展開 →
  // 展開済み範囲全体(単発イベント込み)を store に反映する
  useEffect(() => {
    let cancelled = false

    async function init() {
      const database = await openHiyoriDB()
      if (cancelled) return

      const existingSeriesCount = await countSeries(database)
      if (existingSeriesCount === 0) {
        const series = generateDummySeries(timeZone)
        const overrides = generateDummyOverrides(series)
        const singles = generateDummyOccurrences(Temporal.Now.plainDateISO(), timeZone)
        await putSeries(database, series)
        await Promise.all(overrides.map((o) => putOverride(database, o)))
        await putOccurrences(database, singles)
      }
      if (cancelled) return

      const initialRange = weekRangeMs(weekStart, timeZone)
      await ensureExpanded(database, store, initialRange.fromMs, initialRange.toMs)
      if (cancelled) return

      const state = await getExpansionState(database)
      if (state) {
        const all = await getOccurrencesBetween(database, state.expandedFromMs, state.expandedToMs)
        if (!cancelled) store.load(all)
      }

      if (!cancelled) setDb(database)
    }

    init().catch((err) => {
      console.error('hiyori: initialization failed', err)
    })

    return () => {
      cancelled = true
    }
    // 初回マウント時にのみ実行する。weekStart はマウント時点の値で固定してよい
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 週ナビゲーション時: 表示範囲を賄うのに十分な展開が済んでいるか確認する
  useEffect(() => {
    if (!db) return
    const { fromMs, toMs } = weekRangeMs(weekStart, timeZone)
    ensureExpanded(db, store, fromMs, toMs).catch((err) => {
      console.error('hiyori: ensureExpanded failed', err)
    })
  }, [db, weekStart, timeZone, store])

  // ドラッグ確定時の永続化。store.update は WeekGrid 側で同期的に呼ばれる
  // (楽観的更新)。ここでは IndexedDB への書き込みだけを非同期・fire-and-forget で行う
  const handlePersist = useCallback(
    (updated: Occurrence) => {
      if (!db) return
      async function run() {
        if (!db) return
        if (updated.seriesId && updated.originalStartMs !== undefined) {
          await putOverride(db, {
            id: instanceId(updated.seriesId, updated.originalStartMs),
            seriesId: updated.seriesId,
            originalStartMs: updated.originalStartMs,
            patch: { startMs: updated.startMs, endMs: updated.endMs },
          })
        }
        await putOccurrence(db, updated)
      }
      run().catch((err) => {
        console.error('hiyori: failed to persist occurrence update', err)
      })
    },
    [db],
  )

  const withNavLock = useCallback((run: () => void) => {
    if (navLockRef.current) return
    navLockRef.current = true
    run()
    window.setTimeout(() => {
      navLockRef.current = false
    }, NAV_LOCK_MS)
  }, [])

  const goToPrevWeek = useCallback(() => {
    withNavLock(() => setWeekStart((w) => w.subtract({ weeks: 1 })))
  }, [withNavLock])

  const goToNextWeek = useCallback(() => {
    withNavLock(() => setWeekStart((w) => w.add({ weeks: 1 })))
  }, [withNavLock])

  const goToToday = useCallback(() => {
    withNavLock(() => setWeekStart(mondayOf(Temporal.Now.plainDateISO())))
  }, [withNavLock])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      if (e.key === 'ArrowLeft') {
        goToPrevWeek()
      } else if (e.key === 'ArrowRight') {
        goToNextWeek()
      } else if (e.key === 't' || e.key === 'T') {
        goToToday()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [goToPrevWeek, goToNextWeek, goToToday])

  return (
    <div className="app">
      <header className="toolbar">
        <span className="logo">hiyori</span>
        <div className="toolbar-nav">
          <button type="button" onClick={goToPrevWeek} aria-label="前週">
            ←
          </button>
          <button type="button" onClick={goToToday}>
            今日
          </button>
          <button type="button" onClick={goToNextWeek} aria-label="次週">
            →
          </button>
        </div>
        <span className="month-label">
          {weekStart.year}年{weekStart.month}月
        </span>
      </header>
      <main className="app-main">
        <WeekGrid store={store} weekStart={weekStart} timeZone={timeZone} onPersist={handlePersist} />
      </main>
    </div>
  )
}

export default App
