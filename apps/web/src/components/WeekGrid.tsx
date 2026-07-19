import { useEffect, useMemo, useRef, useState } from 'react'
import { Temporal } from '@js-temporal/polyfill'
import type { Occurrence } from '../model/types'
import { packColumns } from '../layout/packColumns'
import './WeekGrid.css'

const HOUR_HEIGHT = 48
const DAY_HEIGHT = HOUR_HEIGHT * 24
const INITIAL_SCROLL_HOUR = 8
const COMPACT_THRESHOLD_MIN = 40
const WEEKDAY_LABELS = ['月', '火', '水', '木', '金', '土', '日']

interface WeekGridProps {
  occurrences: Occurrence[]
  weekStart: Temporal.PlainDate
  timeZone: string
}

function minutesToPx(minutes: number): number {
  return minutes * (HOUR_HEIGHT / 60)
}

function formatTime(ms: number, timeZone: string): string {
  const zdt = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(timeZone)
  return `${zdt.hour}:${String(zdt.minute).padStart(2, '0')}`
}

export function WeekGrid({ occurrences, weekStart, timeZone }: WeekGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [nowMs, setNowMs] = useState(() => Temporal.Now.instant().epochMilliseconds)

  // 現在時刻線を1分ごとに更新
  useEffect(() => {
    const id = setInterval(() => {
      setNowMs(Temporal.Now.instant().epochMilliseconds)
    }, 60_000)
    return () => clearInterval(id)
  }, [])

  // 初期スクロール位置を朝8時あたりに合わせる
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: minutesToPx(INITIAL_SCROLL_HOUR * 60) })
  }, [])

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => weekStart.add({ days: i })),
    [weekStart],
  )

  const todayPlainDate = useMemo(
    () => Temporal.Instant.fromEpochMilliseconds(nowMs).toZonedDateTimeISO(timeZone).toPlainDate(),
    [nowMs, timeZone],
  )

  const dayData = useMemo(
    () =>
      days.map((day) => {
        const dayStartMs = day.toZonedDateTime({ timeZone }).epochMilliseconds
        const dayEndMs = day.add({ days: 1 }).toZonedDateTime({ timeZone }).epochMilliseconds
        const items = occurrences.filter((o) => o.startMs >= dayStartMs && o.startMs < dayEndMs)
        const positioned = packColumns(
          items,
          (o) => o.startMs,
          (o) => o.endMs,
        )
        return { day, dayStartMs, dayEndMs, positioned }
      }),
    [days, occurrences, timeZone],
  )

  return (
    <div className="week-grid">
      <div className="week-grid-scroll" ref={scrollRef}>
        <div className="week-grid-inner">
          <div className="week-grid-corner" />
          {days.map((day) => {
            const isToday = day.equals(todayPlainDate)
            return (
              <div
                key={day.toString()}
                className={isToday ? 'week-grid-day-header is-today' : 'week-grid-day-header'}
              >
                <span className="weekday">{WEEKDAY_LABELS[day.dayOfWeek - 1]}</span>
                <span className="date">{day.day}</span>
              </div>
            )
          })}

          <div className="week-grid-time-gutter" style={{ height: DAY_HEIGHT }}>
            {Array.from({ length: 24 }, (_, hour) => (
              <div key={hour} className="hour-label" style={{ top: minutesToPx(hour * 60) }}>
                {hour}:00
              </div>
            ))}
          </div>

          {dayData.map(({ day, dayStartMs, dayEndMs, positioned }) => {
            const isToday = day.equals(todayPlainDate)
            const showNowLine = isToday && nowMs >= dayStartMs && nowMs < dayEndMs
            const nowTop = minutesToPx((nowMs - dayStartMs) / 60_000)

            return (
              <div
                key={day.toString()}
                className={isToday ? 'week-grid-day-column is-today' : 'week-grid-day-column'}
                style={{ height: DAY_HEIGHT }}
              >
                {positioned.map(({ item, column, columnCount }) => {
                  const durationMin = (item.endMs - item.startMs) / 60_000
                  const isCompact = durationMin < COMPACT_THRESHOLD_MIN
                  const top = minutesToPx((item.startMs - dayStartMs) / 60_000)
                  const height = Math.max(minutesToPx(durationMin), 4)
                  const widthPct = 100 / columnCount

                  return (
                    <div
                      key={item.id}
                      className={isCompact ? 'event event--compact' : 'event'}
                      style={{
                        top,
                        height,
                        left: `${column * widthPct}%`,
                        width: `calc(${widthPct}% - 2px)`,
                        backgroundColor: `${item.color}26`,
                        borderLeftColor: item.color,
                      }}
                      title={item.title}
                    >
                      {isCompact ? (
                        <span className="event-line">
                          <span className="event-time">{formatTime(item.startMs, timeZone)}</span>
                          <span className="event-title">{item.title}</span>
                        </span>
                      ) : (
                        <>
                          <span className="event-time">{formatTime(item.startMs, timeZone)}</span>
                          <span className="event-title">{item.title}</span>
                        </>
                      )}
                    </div>
                  )
                })}
                {showNowLine && (
                  <div className="now-line" style={{ top: nowTop }}>
                    <span className="now-line-dot" />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
