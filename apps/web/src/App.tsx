import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Temporal } from '@js-temporal/polyfill'
import { WeekGrid } from './components/WeekGrid'
import { generateDummyOccurrences } from './model/dummy'
import { OccurrenceStore } from './store/occurrenceStore'
import './App.css'

/** 指定日を含む週の月曜日 */
function mondayOf(date: Temporal.PlainDate): Temporal.PlainDate {
  return date.subtract({ days: date.dayOfWeek - 1 })
}

// 週切替アニメーション(WeekGrid 側 SLIDE_MS=200ms)より少し長めに連打をロックする
const NAV_LOCK_MS = 220

function App() {
  const timeZone = useMemo(() => Temporal.Now.timeZoneId(), [])
  const [weekStart, setWeekStart] = useState(() => mondayOf(Temporal.Now.plainDateISO()))
  const navLockRef = useRef(false)

  const store = useMemo(() => {
    const s = new OccurrenceStore()
    s.load(generateDummyOccurrences(Temporal.Now.plainDateISO(), timeZone))
    return s
    // timeZone は初回マウント時点の値で固定してよい(端末のTZが動的に変わる想定はない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        <WeekGrid store={store} weekStart={weekStart} timeZone={timeZone} />
      </main>
    </div>
  )
}

export default App
