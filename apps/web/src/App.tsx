import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Temporal } from '@js-temporal/polyfill'
import type { IDBPDatabase } from 'idb'
import type { CalendarListEntryDTO, MeResponse, SyncRequest, SyncResponse } from '@kichijitsu/shared'
import { WeekGrid } from './components/WeekGrid'
import { generateDummyOccurrences, generateDummyOverrides, generateDummySeries } from './model/dummy'
import { instanceId } from './model/series'
import type { Occurrence } from './model/types'
import { OccurrenceStore } from './store/occurrenceStore'
import {
  countSeries,
  getExpansionState,
  getOccurrencesBetween,
  openKichijitsuDB,
  putOccurrence,
  putOccurrences,
  putOverride,
  putSeries,
  type KichijitsuDB,
} from './db/database'
import { ensureExpanded } from './expansion/ensureExpanded'
import { applySyncResponse } from './sync/applySync'
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
  const [db, setDb] = useState<IDBPDatabase<KichijitsuDB> | null>(null)

  const [me, setMe] = useState<MeResponse>({ connected: false })
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'error'>('idle')
  const autoSyncedRef = useRef(false)

  // 起動時: DB を開く → 初回のみ dummy データをシード → 表示週ぶんを展開 →
  // 展開済み範囲全体(単発イベント込み)を store に反映する
  useEffect(() => {
    let cancelled = false

    async function init() {
      const database = await openKichijitsuDB()
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
      console.error('kichijitsu: initialization failed', err)
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
      console.error('kichijitsu: ensureExpanded failed', err)
    })
  }, [db, weekStart, timeZone, store])

  // 起動時: Google 連携状態を確認する。バックエンド (apps/sync) が起動していない
  // 場合の fetch 失敗 / 非 2xx は「未接続」として静かに扱う(コンソールを汚さない)
  useEffect(() => {
    let cancelled = false
    async function checkMe() {
      try {
        const res = await fetch('/api/me')
        if (!res.ok) {
          if (!cancelled) setMe({ connected: false })
          return
        }
        const data = (await res.json()) as MeResponse
        if (!cancelled) setMe(data)
      } catch {
        if (!cancelled) setMe({ connected: false })
      }
    }
    checkMe()
    return () => {
      cancelled = true
    }
  }, [])

  // 「同期」ボタン・自動同期の共通処理: プライマリカレンダーを取得して /api/sync → 適用
  const runSync = useCallback(async () => {
    if (!db) return
    setSyncStatus('syncing')
    try {
      const calendarsRes = await fetch('/api/calendars')
      if (!calendarsRes.ok) {
        throw new Error(`GET /api/calendars failed: ${calendarsRes.status}`)
      }
      const calendars = (await calendarsRes.json()) as CalendarListEntryDTO[]
      const target = calendars.find((c) => c.primary) ?? calendars[0]
      if (!target) {
        throw new Error('no calendars returned from /api/calendars')
      }

      const syncRes = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendarId: target.id } satisfies SyncRequest),
      })
      if (!syncRes.ok) {
        throw new Error(`POST /api/sync failed: ${syncRes.status}`)
      }
      const syncData = (await syncRes.json()) as SyncResponse

      await applySyncResponse(db, store, syncData)
      setSyncStatus('idle')
    } catch (err) {
      console.error('kichijitsu: sync failed', err)
      setSyncStatus('error')
    }
  }, [db, store])

  // 接続済み & DB 準備完了なら起動時に1回だけ自動同期する
  useEffect(() => {
    if (!db || !me.connected || autoSyncedRef.current) return
    autoSyncedRef.current = true
    runSync()
  }, [db, me.connected, runSync])

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
        console.error('kichijitsu: failed to persist occurrence update', err)
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
        <span className="logo">kichijitsu</span>
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
        <div className="toolbar-right">
          <span className="month-label">
            {weekStart.year}年{weekStart.month}月
          </span>
          <div className="toolbar-account">
            {me.connected ? (
              <>
                {me.email && <span className="account-email">{me.email}</span>}
                <button type="button" onClick={runSync} disabled={syncStatus === 'syncing'}>
                  {syncStatus === 'syncing' ? '同期中…' : '同期'}
                </button>
                {syncStatus === 'error' && <span className="sync-error">同期失敗</span>}
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  window.location.href = '/auth/login'
                }}
              >
                Google 連携
              </button>
            )}
          </div>
        </div>
      </header>
      <main className="app-main">
        <WeekGrid store={store} weekStart={weekStart} timeZone={timeZone} onPersist={handlePersist} />
      </main>
    </div>
  )
}

export default App
