import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Temporal } from '@js-temporal/polyfill'
import type { Occurrence } from '../model/types'
import type { OccurrenceStore } from '../store/occurrenceStore'
import { useOccurrences } from '../store/occurrenceStore'
import type { AllDayStore } from '../store/allDayStore'
import { useAllDayOccurrences } from '../store/allDayStore'
import { packColumns } from '../layout/packColumns'
import { packDayBars } from '../layout/packDayBars'
import {
  groupDuplicateAllDayOccurrences,
  groupDuplicateOccurrences,
  type OccurrenceGroup,
} from '../layout/groupDuplicates'
import { isBusyPlaceholder, minutesToPx, WEEKDAY_LABELS } from '../layout/gridMetrics'
import { EventBlock, type CalendarInfo } from './EventBlock'
import { AllDayBar } from './AllDayBar'
import './WeekGrid.css'

const INITIAL_SCROLL_HOUR = 8
const COMPACT_THRESHOLD_MIN = 40
const SLIDE_MS = 200

/**
 * 終日レーン(フェーズ5)のレイアウト定数。ROW_HEIGHT はバー1行ぶんの px 高さ、
 * MAX_VISIBLE_ROWS は実際にバーとして描画する最大行数(それを超える分は
 * 日ごとの「+N」表示にまとめる、Google カレンダーの月表示と同じ考え方)
 */
const ALLDAY_ROW_HEIGHT = 20
const ALLDAY_MAX_VISIBLE_ROWS = 3

/**
 * カスケード表示(フェーズ5): 重なる予定は列ごとに等分せず、少しずつ右へ
 * ずらして重ねる(left = column * step, width = 残り全部)。CASCADE_STEP_FRAC は
 * 通常時のずれ幅(使用可能幅に対する割合)、CASCADE_MIN_CARD_FRAC は最前面
 * カード(最後列、常に全幅まで見える)の最低幅 — タイトルが読める下限。
 * 列数が多いときは step を縮めて全カードの左端がグリッド内に収まるようにする。
 */
const CASCADE_STEP_FRAC = 0.14
const CASCADE_MIN_CARD_FRAC = 0.32

function cascadeStepFrac(columnCount: number): number {
  if (columnCount <= 1) return 0
  return Math.min(CASCADE_STEP_FRAC, (1 - CASCADE_MIN_CARD_FRAC) / (columnCount - 1))
}

interface WeekGridProps {
  store: OccurrenceStore
  /** 終日予定 (フェーズ5) の読み口。時刻予定の store と対になる別ストア */
  allDayStore: AllDayStore
  weekStart: Temporal.PlainDate
  timeZone: string
  /**
   * ドラッグ確定時、store.update に加えて呼ばれる永続化フック
   * (IndexedDB 書き込み・Google 由来なら書き戻しは App 側が担う)。
   * previous は store.update 直前の occurrence (ロールバック用のスナップショット)
   */
  onPersist: (updated: Occurrence, previous: Occurrence | undefined) => void
  /**
   * 選択中カレンダーの `${accountId}:${calendarId}` キー集合(マルチアカウント対応 2026-07-19)。
   * source==='google' な occurrence だけをこれでフィルタする。ローカル/未設定 source
   * (source !== 'google') は選択状態に関係なく常に表示する。
   */
  visibleCalendarKeys: Set<string>
  /** `${accountId}:${calendarId}` → カレンダー名/色。EventBlock の詳細ポップオーバーが「どのカレンダーか」を出すのに使う */
  calendarLookup: Map<string, CalendarInfo>
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
  dayData: { day: Temporal.PlainDate; positioned: ReturnType<typeof packColumns<OccurrenceGroup>> }[]
}

/** 終日レーンの「+N」表示用。非表示になったバーの件数とタイトル一覧(title 属性で列挙する) */
interface AllDayOverflowInfo {
  count: number
  titles: string[]
}

export function WeekGrid({
  store,
  allDayStore,
  weekStart,
  timeZone,
  onPersist,
  visibleCalendarKeys,
  calendarLookup,
}: WeekGridProps) {
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

  // カレンダー選択(マルチアカウント対応 2026-07-19): google 由来だけを
  // visibleCalendarKeys でフィルタする。ローカルデータは常に表示する
  const visibleOccurrences = useMemo(
    () =>
      occurrences.filter(
        (o) => o.source !== 'google' || visibleCalendarKeys.has(`${o.accountId}:${o.calendarId}`),
      ),
    [occurrences, visibleCalendarKeys],
  )

  // 同一予定の集約(フェーズ5): iCalUID + startMs + endMs が一致する複数アカウント/
  // カレンダーのコピーを1グループ(1カード)にまとめる。iCalUID が無い occurrence は
  // 単独グループのまま。レンダーごとの再計算を避けるためメモ化する
  const groupedOccurrences = useMemo(
    () => groupDuplicateOccurrences(visibleOccurrences),
    [visibleOccurrences],
  )

  const weekPanels = useMemo<WeekPanelData[]>(
    () =>
      weeks.map((weekPanelStart) => {
        const days = Array.from({ length: 7 }, (_, i) => weekPanelStart.add({ days: i }))
        const dayStarts = days.map((d) => d.toZonedDateTime({ timeZone }).epochMilliseconds)
        const dayEnds = [...dayStarts.slice(1), weekPanelStart.add({ days: 7 }).toZonedDateTime({ timeZone }).epochMilliseconds]
        const dayData = days.map((day, i) => {
          const items = groupedOccurrences.filter(
            (g) => g.primary.startMs >= dayStarts[i] && g.primary.startMs < dayEnds[i],
          )
          const positioned = packColumns(
            items,
            (g) => g.primary.startMs,
            (g) => g.primary.endMs,
          )
          return { day, positioned }
        })
        return { weekPanelStart, days, dayStarts, dayEnds, dayData }
      }),
    [weeks, groupedOccurrences, timeZone],
  )

  // ---- 終日レーン (フェーズ5) ----
  // 展開ウィンドウの概念が無い終日予定は、表示中3週ぶんの日付範囲 [fromDate, toDate]
  // (inclusive) をそのまま AllDayStore に問い合わせる(時刻予定の rangeStartMs/EndMs と対応)
  const allDayFromDate = useMemo(() => weeks[0].toString(), [weeks])
  const allDayToDate = useMemo(() => weeks[2].add({ days: 6 }).toString(), [weeks])
  const allDayOccurrencesRaw = useAllDayOccurrences(allDayStore, allDayFromDate, allDayToDate)

  // カレンダー選択・同一予定集約は時刻予定と同じ扱い(要望どおり)
  const visibleAllDayOccurrences = useMemo(
    () =>
      allDayOccurrencesRaw.filter(
        (o) => o.source !== 'google' || visibleCalendarKeys.has(`${o.accountId}:${o.calendarId}`),
      ),
    [allDayOccurrencesRaw, visibleCalendarKeys],
  )
  const groupedAllDayOccurrences = useMemo(
    () => groupDuplicateAllDayOccurrences(visibleAllDayOccurrences),
    [visibleAllDayOccurrences],
  )

  // 週ごとに、その週の日インデックス [0,6] にクリップした区間で packDayBars する。
  // 行の割り当てはここで確定するが、「何行まで見せるか(sharedVisibleRows)」は
  // 3週分の最大行数を見てから決めるため、この時点では行を絞り込まない
  const rawAllDayPanels = useMemo(
    () =>
      weeks.map((weekPanelStart) => {
        const weekEndDate = weekPanelStart.add({ days: 6 })
        const relevant = groupedAllDayOccurrences.filter((g) => {
          const s = Temporal.PlainDate.from(g.primary.startDate)
          const e = Temporal.PlainDate.from(g.primary.endDate)
          return Temporal.PlainDate.compare(s, weekEndDate) <= 0 && Temporal.PlainDate.compare(e, weekPanelStart) >= 0
        })
        const clipped = relevant.map((group) => {
          const s = Temporal.PlainDate.from(group.primary.startDate)
          const e = Temporal.PlainDate.from(group.primary.endDate)
          const startDayIndex = Math.max(0, weekPanelStart.until(s, { largestUnit: 'day' }).days)
          const endDayIndex = Math.min(6, weekPanelStart.until(e, { largestUnit: 'day' }).days)
          return { group, startDayIndex, endDayIndex }
        })
        const positioned = packDayBars(clipped, (b) => b.startDayIndex, (b) => b.endDayIndex)
        return {
          weekPanelStart,
          bars: positioned.map((p) => ({ ...p.item, row: p.row })),
        }
      }),
    [weeks, groupedAllDayOccurrences],
  )

  // 3週(prev/current/next)で共有する表示行数。行数が多い日があっても最大 3 行までバーを見せ、
  // それを超える分は「+N」に畳む。3週の中で1週でも溢れていれば +N 用の1行を全週共通で確保する
  // (パネルごとに高さが変わるとスライドアニメーション中に見た目が揃わないため)
  const { allDayVisibleRows, allDayHasOverflow } = useMemo(() => {
    let maxRows = 0
    let anyOverflow = false
    for (const panel of rawAllDayPanels) {
      for (const bar of panel.bars) {
        maxRows = Math.max(maxRows, bar.row + 1)
        if (bar.row >= ALLDAY_MAX_VISIBLE_ROWS) anyOverflow = true
      }
    }
    return { allDayVisibleRows: Math.min(ALLDAY_MAX_VISIBLE_ROWS, maxRows), allDayHasOverflow: anyOverflow }
  }, [rawAllDayPanels])
  const allDayLaneRows = allDayVisibleRows + (allDayHasOverflow ? 1 : 0)

  const allDayPanels = useMemo(
    () =>
      rawAllDayPanels.map(({ weekPanelStart, bars }) => {
        const visibleBars = bars.filter((b) => b.row < allDayVisibleRows)
        const overflowByDay: AllDayOverflowInfo[] = Array.from({ length: 7 }, () => ({ count: 0, titles: [] }))
        for (const b of bars) {
          if (b.row < allDayVisibleRows) continue
          for (let d = b.startDayIndex; d <= b.endDayIndex; d++) {
            overflowByDay[d].count++
            overflowByDay[d].titles.push(b.group.primary.title)
          }
        }
        return { weekPanelStart, visibleBars, overflowByDay }
      }),
    [rawAllDayPanels, allDayVisibleRows],
  )

  const handleCommit = useCallback(
    (updated: Occurrence) => {
      // ロールバック用に更新前のスナップショットを取ってから、楽観的・同期に
      // store を即座に更新して見た目に反映する
      const previous = store.get(updated.id)
      store.update(updated)
      // 永続化は非同期・fire-and-forget(App 側が db 書き込み・Google 書き戻しを担当)
      onPersist(updated, previous)
    },
    [store, onPersist],
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
                      <span className="date">
                        {isToday ? <span className="date-num">{day.day}</span> : day.day}
                      </span>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {allDayLaneRows > 0 && (
        <div className="week-grid-allday">
          <div className="week-grid-allday-gutter">終日</div>
          <div className="week-grid-allday-viewport">
            <div className="week-grid-allday-strip" style={stripStyle}>
              {allDayPanels.map(({ weekPanelStart, visibleBars, overflowByDay }) => (
                <div
                  className="week-grid-allday-panel"
                  key={weekPanelStart.toString()}
                  style={{ gridTemplateRows: `repeat(${allDayLaneRows}, ${ALLDAY_ROW_HEIGHT}px)` }}
                >
                  {visibleBars.map((b) => (
                    <AllDayBar
                      key={b.group.primary.id}
                      occurrence={b.group.primary}
                      groupMembers={b.group.members}
                      row={b.row + 1}
                      colStart={b.startDayIndex + 1}
                      colEnd={b.endDayIndex + 2}
                      calendarLookup={calendarLookup}
                    />
                  ))}
                  {overflowByDay.map((info, dayIndex) =>
                    info.count > 0 ? (
                      <div
                        key={`overflow-${dayIndex}`}
                        className="allday-overflow"
                        style={{ gridRow: allDayVisibleRows + 1, gridColumn: dayIndex + 1 }}
                        title={info.titles.join('\n')}
                      >
                        +{info.count}
                      </div>
                    ) : null,
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

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

                    // カスケードの前面/背面: 列番号ではなく「開始が遅いほど前面」で決める。
                    // 各カードのタイトル/時刻は上端(=開始時刻)にあるため、遅く始まるカードを
                    // 前面にしてもそこは先行カードの本体部分で、タイトルを覆わない。
                    // 同時刻は短い予定を前面に(長い予定に埋もれた短い予定をクリック可能に保つ)。
                    // ただし Busy/予定あり のプレースホルダは中身が無いので無条件に最背面へ。
                    const stackZ = new Map<string, number>()
                    positioned
                      .map((p) => p.item.primary)
                      .sort((a, b) => {
                        const busyA = isBusyPlaceholder(a.title) ? 0 : 1
                        const busyB = isBusyPlaceholder(b.title) ? 0 : 1
                        return busyA - busyB || a.startMs - b.startMs || b.endMs - a.endMs
                      })
                      .forEach((occ, rank) => stackZ.set(occ.id, rank))

                    return (
                      <div
                        key={day.toString()}
                        className={isToday ? 'week-grid-day-column is-today' : 'week-grid-day-column'}
                      >
                        {positioned.map(({ item: group, column, columnCount }) => {
                          const occurrence = group.primary
                          const durationMin = (occurrence.endMs - occurrence.startMs) / 60_000
                          const isCompact = durationMin < COMPACT_THRESHOLD_MIN
                          const topPx = minutesToPx((occurrence.startMs - dayStartMs) / 60_000)
                          const heightPx = Math.max(minutesToPx(durationMin), 4)
                          // カスケード表示(フェーズ5): 列ごとに等分せず、少しずつ右へ
                          // ずらして重ねる(left=column*step, width=残り全部)
                          const step = cascadeStepFrac(columnCount)
                          const leftPct = column * step * 100
                          const widthPct = 100 - leftPct
                          const stackIndex = stackZ.get(occurrence.id) ?? column

                          return (
                            <EventBlock
                              key={occurrence.id}
                              occurrence={occurrence}
                              groupMembers={group.members}
                              stackIndex={stackIndex}
                              top={topPx}
                              height={heightPx}
                              leftPct={leftPct}
                              widthPct={widthPct}
                              isCompact={isCompact}
                              timeZone={timeZone}
                              dayIndex={dayIndex}
                              dayStartMs={dayStartMs}
                              weekDayStarts={dayStarts}
                              onCommit={handleCommit}
                              calendarLookup={calendarLookup}
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
