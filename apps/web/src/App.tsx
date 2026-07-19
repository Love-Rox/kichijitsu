import { useMemo } from 'react'
import { Temporal } from '@js-temporal/polyfill'
import { WeekGrid } from './components/WeekGrid'
import { generateDummyOccurrences } from './model/dummy'
import './App.css'

function App() {
  const timeZone = Temporal.Now.timeZoneId()
  const today = Temporal.Now.plainDateISO()
  const weekStart = today.subtract({ days: today.dayOfWeek - 1 })

  const occurrences = useMemo(() => generateDummyOccurrences(today, timeZone), [today, timeZone])

  return (
    <div className="app">
      <header className="toolbar">
        <span className="logo">hiyori</span>
        <span className="month-label">
          {today.year}年{today.month}月
        </span>
      </header>
      <main className="app-main">
        <WeekGrid occurrences={occurrences} weekStart={weekStart} timeZone={timeZone} />
      </main>
    </div>
  )
}

export default App
