import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Temporal } from '@js-temporal/polyfill'
import type { Occurrence } from '../model/types'
import type { OccurrenceStore } from '../store/occurrenceStore'
import { useOccurrences } from '../store/occurrenceStore'
import { packColumns } from '../layout/packColumns'
import { minutesToPx } from '../layout/gridMetrics'
import { EventBlock } from './EventBlock'
import './WeekGrid.css'

const INITIAL_SCROLL_HOUR = 8
const COMPACT_THRESHOLD_MIN = 40
const SLIDE_MS = 200
const WEEKDAY_LABELS = ['月', '火', '水', '木', '金', '土', '日']

interface WeekGridProps {
  store: OccurrenceStore
  weekStart: Temporal.PlainDate
  timeZone: string
}

type SlidePhase = 'idle' | 'next' | 'prev'

/** phase から strip の transform を求める。3週(prev/current/next)のうち中央(=index1)が既定表示 */
function transformForPhase(phase: SlidePhase): string {
  if (phase === 'next') return 'translateX(-66.6667%)'
  if (phase === 'prev') return 'translateX(0%)'
  return 'translateX(-33.3333%)'
}

interface WeekPanelData {
  weekPanelStart: Temporal.PlainDate
  days: Temporal.PlainDate[]
  dayStarts: number[]
  dayEnds: number[]
  dayData: { day: Temporal.PlainDate; positioned: ReturnType<typeof packColumns<Occurrence>> }[]
}

export function WeekGrid({ store, weekStart, timeZone }: WeekGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [nowMs, setNowMs] = useState(() => Temporal.Now.instant().epochMilliseconds)

  // 表示中(=アニメーション完了済み)の中央週。ストリップは常にこの ±1週の3週ぶんだけ DOM を持つ
  const [center, setCenter] = useState(weekStart)
  const [phase, setPhase] = useState<SlidePhase>('idle')
  // true の間は transform の transition を切る(スワップ直後の瞬間ジャンプを無アニメで行うため)
  const [instant, setInstant] = useState(true)
  const slideTimeoutRef = useRef<number | undefined>(undefined)

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

  // weekStart (App が持つ状態) が変わったら center に反映する。
  // ちょうど隣の週への移動ならスライドアニメーションし、それ以外(today ジャンプ等)は瞬時に切り替える。
  useEffect(() => {
    if (weekStart.equals(center)) return
    if (slideTimeoutRef.current !== undefined) {
      window.clearTimeout(slideTimeoutRef.current)
      slideTimeoutRef.current = undefined
    }
    const deltaDays = weekStart.since(center, { largestUnit: 'day' }).days

    if (deltaDays === 7 || deltaDays === -7) {
      setInstant(false)
      setPhase(deltaDays === 7 ? 'next' : 'prev')
      slideTimeoutRef.current = window.setTimeout(() => {
        setInstant(true)
        setPhase('idle')
        setCenter(weekStart)
        // instant での瞬間ジャンプが確実に1フレーム描画されてから transition を戻す
        requestAnimationFrame(() => {
          requestAnimationFrame(() => setInstant(false))
        })
      }, SLIDE_MS)
    } else {
      setInstant(true)
      setPhase('idle')
      setCenter(weekStart)
    }
    // center は effect 内でのみ更新するので依存に含めない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart])

  useEffect(
    () => () => {
      if (slideTimeoutRef.current !== undefined) window.clearTimeout(slideTimeoutRef.current)
    },
    [],
  )

  const weeks = useMemo(
    () => [center.subtract({ weeks: 1 }), center, center.add({ weeks: 1 })],
    [center],
  )

  const todayPlainDate = useMemo(
    () => Temporal.Instant.fromEpochMilliseconds(nowMs).toZonedDateTimeISO(timeZone).toPlainDate(),
    [nowMs, timeZone],
  )

  const rangeStartMs = useMemo(
    () => weeks[0].toZonedDateTime({ timeZone }).epochMilliseconds,
    [weeks, timeZone],
  )
  const rangeEndMs = useMemo(
    () => weeks[2].add({ days: 7 }).toZonedDateTime({ timeZone }).epochMilliseconds,
    [weeks, timeZone],
  )
  const occurrences = useOccurrences(store, rangeStartMs, rangeEndMs)

  const weekPanels = useMemo<WeekPanelData[]>(
    () =>
      weeks.map((weekPanelStart) => {
        const days = Array.from({ length: 7 }, (_, i) => weekPanelStart.add({ days: i }))
        const dayStarts = days.map((d) => d.toZonedDateTime({ timeZone }).epochMilliseconds)
        const dayEnds = [...dayStarts.slice(1), weekPanelStart.add({ days: 7 }).toZonedDateTime({ timeZone }).epochMilliseconds]
        const dayData = days.map((day, i) => {
          const items = occurrences.filter(
            (o) => o.startMs >= dayStarts[i] && o.startMs < dayEnds[i],
          )
          const positioned = packColumns(
            items,
            (o) => o.startMs,
            (o) => o.endMs,
          )
          return { day, positioned }
        })
        return { weekPanelStart, days, dayStarts, dayEnds, dayData }
      }),
    [weeks, occurrences, timeZone],
  )

  const handleCommit = useCallback(
    (updated: Occurrence) => {
      store.update(updated)
    },
    [store],
  )

  const transform = transformForPhase(phase)
  const stripStyle = {
    transform,
    transition: instant ? 'none' : `transform ${SLIDE_MS}ms ease`,
  }

  return (
    <div className="week-grid">
      <div className="week-grid-header">
        <div className="week-grid-header-gutter" />
        <div className="week-grid-header-viewport">
          <div className="week-grid-header-strip" style={stripStyle}>
            {weekPanels.map(({ weekPanelStart, days }) => (
              <div className="week-grid-header-panel" key={weekPanelStart.toString()}>
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
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="week-grid-scroll" ref={scrollRef}>
        <div className="week-grid-body">
          <div className="week-grid-gutter">
            {Array.from({ length: 24 }, (_, hour) => (
              <div key={hour} className="hour-label" style={{ top: minutesToPx(hour * 60) }}>
                {hour}:00
              </div>
            ))}
          </div>

          <div className="week-grid-days-viewport">
            <div className="week-grid-days-strip" style={stripStyle}>
              {weekPanels.map(({ weekPanelStart, dayStarts, dayEnds, dayData }) => (
                <div className="week-grid-days-panel" key={weekPanelStart.toString()}>
                  {dayData.map(({ day, positioned }, dayIndex) => {
                    const dayStartMs = dayStarts[dayIndex]
                    const dayEndMs = dayEnds[dayIndex]
                    const isToday = day.equals(todayPlainDate)
                    const showNowLine = isToday && nowMs >= dayStartMs && nowMs < dayEndMs
                    const nowTop = minutesToPx((nowMs - dayStartMs) / 60_000)

                    return (
                      <div
                        key={day.toString()}
                        className={isToday ? 'week-grid-day-column is-today' : 'week-grid-day-column'}
                      >
                        {positioned.map(({ item, column, columnCount }) => {
                          const durationMin = (item.endMs - item.startMs) / 60_000
                          const isCompact = durationMin < COMPACT_THRESHOLD_MIN
                          const topPx = minutesToPx((item.startMs - dayStartMs) / 60_000)
                          const heightPx = Math.max(minutesToPx(durationMin), 4)
                          const widthPct = 100 / columnCount

                          return (
                            <EventBlock
                              key={item.id}
                              occurrence={item}
                              top={topPx}
                              height={heightPx}
                              leftPct={column * widthPct}
                              widthPct={widthPct}
                              isCompact={isCompact}
                              timeZone={timeZone}
                              dayIndex={dayIndex}
                              dayStartMs={dayStartMs}
                              weekDayStarts={dayStarts}
                              onCommit={handleCommit}
                            />
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
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
