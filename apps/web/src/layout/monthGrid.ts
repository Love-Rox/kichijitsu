import { Temporal } from '@js-temporal/polyfill'
import type { AllDayOccurrenceGroup, OccurrenceGroup } from './groupDuplicates'

/**
 * 月表示ビュー(フェーズ6)の日付グリッド生成とセルごとのチップ割り当てを担う
 * 純関数群。DOM/React に依存しないため MonthView.tsx から呼ばれる薄いロジック層
 * としてここに切り出し、単体テストしやすくしてある(eventColors.ts/groupDuplicates.ts
 * と同じ流儀)。
 */

/** 指定日を含む週の月曜日。App.tsx の同名ローカル関数と同じ規則(週開始=月曜) */
export function mondayOf(date: Temporal.PlainDate): Temporal.PlainDate {
  return date.subtract({ days: date.dayOfWeek - 1 })
}

export interface MonthGridDay {
  date: Temporal.PlainDate
  /** monthAnchor の月に属する日かどうか(false = 前後月の埋め、淡色表示用) */
  inMonth: boolean
}

const MONTH_GRID_WEEKS = 6
const MONTH_GRID_DAYS = MONTH_GRID_WEEKS * 7

/**
 * monthAnchor(月内の任意の日、通常は1日)を含む月を表示する 6週×7列 = 42日ぶんの
 * 日付グリッドをフラットな配列(行優先: 週0の月〜日、週1の月〜日、…)で返す。
 * 週の開始は月曜(mondayOf と同じ規則)なので、月の1日がどの曜日でも必ず
 * ちょうど6週ぶんで当月全体を覆う。
 */
export function monthGridDays(monthAnchor: Temporal.PlainDate): MonthGridDay[] {
  const firstOfMonth = monthAnchor.with({ day: 1 })
  const gridStart = mondayOf(firstOfMonth)
  return Array.from({ length: MONTH_GRID_DAYS }, (_, i) => {
    const date = gridStart.add({ days: i })
    return { date, inMonth: date.month === firstOfMonth.month && date.year === firstOfMonth.year }
  })
}

/** monthGridDays を週(7日)ごとに分割したもの。MonthView の行描画に使う */
export function monthGridWeeks(monthAnchor: Temporal.PlainDate): MonthGridDay[][] {
  const days = monthGridDays(monthAnchor)
  const weeks: MonthGridDay[][] = []
  for (let i = 0; i < MONTH_GRID_WEEKS; i++) {
    weeks.push(days.slice(i * 7, i * 7 + 7))
  }
  return weeks
}

/**
 * 42日ぶんのグリッド全体(月をまたぐ埋め日も含む)を覆う epoch ms 範囲
 * (timeZone の壁時計基準、半開区間)。App.tsx の weekRangeMs と同じ考え方で、
 * ensureExpanded/useOccurrences にそのまま渡せる。
 */
export function monthGridRangeMs(
  monthAnchor: Temporal.PlainDate,
  timeZone: string,
): { fromMs: number; toMs: number } {
  const days = monthGridDays(monthAnchor)
  const fromMs = days[0].date.toZonedDateTime({ timeZone }).epochMilliseconds
  const toMs = days[days.length - 1].date.add({ days: 1 }).toZonedDateTime({ timeZone }).epochMilliseconds
  return { fromMs, toMs }
}

export type MonthChipKind = 'allday' | 'timed'

/** セル内の1チップ。group は EventDetailCard に渡す subject/groupMembers の元になる */
export interface MonthChip {
  key: string
  kind: MonthChipKind
  title: string
  /** 時刻予定のみ: 「HH:mm タイトル」表示用。終日は undefined */
  startMs?: number
  group: OccurrenceGroup | AllDayOccurrenceGroup
}

export interface MonthCellChips {
  date: Temporal.PlainDate
  /** 表示するチップ(最大 maxChipsPerCell 件、終日→時刻順)  */
  visible: MonthChip[]
  /** 溢れて表示しきれなかった件数(0 なら「+N」を出さない) */
  overflowCount: number
}

const DEFAULT_MAX_CHIPS_PER_CELL = 4

/**
 * days の各日について、その日に属するチップ(終日予定 + 時刻予定)を
 * 「終日を先に、時刻予定は開始時刻順」で並べ、maxChipsPerCell 件を超える分は
 * overflowCount にまとめる(WeekGrid の終日レーンの「+N」と同じ考え方)。
 *
 * timedGroups/allDayGroups はカレンダー選択フィルタ・同一予定集約
 * (groupDuplicateOccurrences/groupDuplicateAllDayOccurrences)を適用済みの状態で
 * 渡すこと(このモジュールはそれらを行わない)。
 *
 * 時刻予定は開始日のみに割り当てる(複数日にまたがる時刻予定の分割表示は v1 対象外、
 * WeekGrid の日別振り分けと同じ簡略化)。終日予定は startDate〜endDate (両端 inclusive)
 * に含まれる全ての日のセルに割り当てる。
 */
export function bucketMonthChips(
  days: readonly MonthGridDay[],
  timedGroups: readonly OccurrenceGroup[],
  allDayGroups: readonly AllDayOccurrenceGroup[],
  timeZone: string,
  maxChipsPerCell: number = DEFAULT_MAX_CHIPS_PER_CELL,
): MonthCellChips[] {
  return days.map(({ date }) => {
    const dateStr = date.toString()
    const dayStartMs = date.toZonedDateTime({ timeZone }).epochMilliseconds
    const dayEndMs = date.add({ days: 1 }).toZonedDateTime({ timeZone }).epochMilliseconds

    const allDayChips: MonthChip[] = allDayGroups
      .filter((g) => g.primary.startDate <= dateStr && g.primary.endDate >= dateStr)
      .map((g) => ({
        key: `allday:${g.primary.id}`,
        kind: 'allday' as const,
        title: g.primary.title,
        group: g,
      }))

    const timedChips: MonthChip[] = timedGroups
      .filter((g) => g.primary.startMs >= dayStartMs && g.primary.startMs < dayEndMs)
      .sort((a, b) => a.primary.startMs - b.primary.startMs)
      .map((g) => ({
        key: `timed:${g.primary.id}`,
        kind: 'timed' as const,
        title: g.primary.title,
        startMs: g.primary.startMs,
        group: g,
      }))

    const all = [...allDayChips, ...timedChips]
    const visible = all.slice(0, maxChipsPerCell)
    const overflowCount = all.length - visible.length

    return { date, visible, overflowCount }
  })
}
