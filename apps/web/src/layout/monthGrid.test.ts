import { Temporal } from '@js-temporal/polyfill'
import { describe, expect, it } from 'vitest'
import type { AllDayOccurrence, Occurrence } from '../model/types'
import type { AllDayOccurrenceGroup, OccurrenceGroup } from './groupDuplicates'
import { bucketMonthChips, monthGridDays, monthGridRangeMs, monthGridWeeks } from './monthGrid'

const TZ = 'Asia/Tokyo'

function occ(overrides: Partial<Occurrence> = {}): Occurrence {
  return {
    id: 'g:acc-1:cal-1:evt-1',
    seriesId: null,
    title: 'Test Event',
    startMs: 0,
    endMs: 1,
    color: '#3b82f6',
    source: 'google',
    accountId: 'acc-1',
    calendarId: 'cal-1',
    ...overrides,
  }
}

function allDayOcc(overrides: Partial<AllDayOccurrence> = {}): AllDayOccurrence {
  return {
    id: 'g:acc-1:cal-1:holiday-1',
    seriesId: null,
    title: '海の日',
    startDate: '2026-07-20',
    endDate: '2026-07-20',
    color: '#3b82f6',
    source: 'google',
    accountId: 'acc-1',
    calendarId: 'cal-1',
    ...overrides,
  }
}

function timedGroup(o: Occurrence): OccurrenceGroup {
  return { primary: o, members: [o] }
}

function allDayGroup(o: AllDayOccurrence): AllDayOccurrenceGroup {
  return { primary: o, members: [o] }
}

describe('monthGridDays', () => {
  it('常に6週x7日=42日を返す', () => {
    const days = monthGridDays(Temporal.PlainDate.from('2026-07-01'))
    expect(days).toHaveLength(42)
  })

  it('各週は月曜始まり(週の先頭7件おきの dayOfWeek が1)', () => {
    const days = monthGridDays(Temporal.PlainDate.from('2026-07-01'))
    for (let i = 0; i < 42; i += 7) {
      expect(days[i].date.dayOfWeek).toBe(1)
    }
  })

  it('月の1日が月曜のとき、先頭に前月の埋め日が無い', () => {
    // 2026-06-01 は月曜
    const anchor = Temporal.PlainDate.from('2026-06-01')
    expect(anchor.dayOfWeek).toBe(1)
    const days = monthGridDays(anchor)
    expect(days[0].date.toString()).toBe('2026-06-01')
    expect(days[0].inMonth).toBe(true)
  })

  it('月の1日が日曜のとき、先頭6日が前月の埋め日になる', () => {
    // 2026-11-01 は日曜
    const anchor = Temporal.PlainDate.from('2026-11-01')
    expect(anchor.dayOfWeek).toBe(7)
    const days = monthGridDays(anchor)
    for (let i = 0; i < 6; i++) {
      expect(days[i].inMonth).toBe(false)
      expect(days[i].date.month).toBe(10)
    }
    expect(days[6].date.toString()).toBe('2026-11-01')
    expect(days[6].inMonth).toBe(true)
  })

  it('当月/月外の判定: 2026-07 は31日あり、月外日を含めて42日を埋める', () => {
    const days = monthGridDays(Temporal.PlainDate.from('2026-07-15'))
    const inMonthDays = days.filter((d) => d.inMonth)
    expect(inMonthDays).toHaveLength(31)
    expect(inMonthDays[0].date.toString()).toBe('2026-07-01')
    expect(inMonthDays[30].date.toString()).toBe('2026-07-31')
  })
})

describe('monthGridWeeks', () => {
  it('6週x7日に分割する', () => {
    const weeks = monthGridWeeks(Temporal.PlainDate.from('2026-07-01'))
    expect(weeks).toHaveLength(6)
    for (const week of weeks) expect(week).toHaveLength(7)
  })
})

describe('monthGridRangeMs', () => {
  it('グリッド先頭日の0時からグリッド最終日の翌0時までの半開区間', () => {
    const anchor = Temporal.PlainDate.from('2026-07-01')
    const days = monthGridDays(anchor)
    const { fromMs, toMs } = monthGridRangeMs(anchor, TZ)
    expect(fromMs).toBe(days[0].date.toZonedDateTime({ timeZone: TZ }).epochMilliseconds)
    expect(toMs).toBe(days[41].date.add({ days: 1 }).toZonedDateTime({ timeZone: TZ }).epochMilliseconds)
    expect(toMs).toBeGreaterThan(fromMs)
  })
})

describe('bucketMonthChips', () => {
  const days = monthGridDays(Temporal.PlainDate.from('2026-07-01'))

  it('時刻予定は開始日のセルにのみ割り当てる', () => {
    const day = Temporal.PlainDate.from('2026-07-20')
    const dayStartMs = day.toZonedDateTime({ timeZone: TZ }).epochMilliseconds
    const groups = [timedGroup(occ({ id: 'evt-a', startMs: dayStartMs + 9 * 60 * 60 * 1000, endMs: dayStartMs + 10 * 60 * 60 * 1000 }))]

    const cells = bucketMonthChips(days, groups, [], TZ)
    const cell = cells.find((c) => c.date.toString() === '2026-07-20')!
    const otherCells = cells.filter((c) => c.date.toString() !== '2026-07-20')

    expect(cell.visible).toHaveLength(1)
    expect(cell.visible[0].kind).toBe('timed')
    expect(cell.visible[0].startMs).toBe(dayStartMs + 9 * 60 * 60 * 1000)
    for (const other of otherCells) {
      expect(other.visible.some((c) => c.key === cell.visible[0].key)).toBe(false)
    }
  })

  it('終日予定は startDate〜endDate の全セルに割り当てる', () => {
    const groups = [allDayGroup(allDayOcc({ id: 'holiday-multi', startDate: '2026-07-19', endDate: '2026-07-21' }))]
    const cells = bucketMonthChips(days, [], groups, TZ)
    for (const dateStr of ['2026-07-19', '2026-07-20', '2026-07-21']) {
      const cell = cells.find((c) => c.date.toString() === dateStr)!
      expect(cell.visible.some((c) => c.kind === 'allday')).toBe(true)
    }
    const before = cells.find((c) => c.date.toString() === '2026-07-18')!
    const after = cells.find((c) => c.date.toString() === '2026-07-22')!
    expect(before.visible).toHaveLength(0)
    expect(after.visible).toHaveLength(0)
  })

  it('終日予定を時刻予定より先に並べる', () => {
    const day = Temporal.PlainDate.from('2026-07-20')
    const dayStartMs = day.toZonedDateTime({ timeZone: TZ }).epochMilliseconds
    const timed = [timedGroup(occ({ id: 'evt-b', startMs: dayStartMs + 3600_000, endMs: dayStartMs + 7200_000 }))]
    const allDay = [allDayGroup(allDayOcc({ id: 'holiday-b', startDate: '2026-07-20', endDate: '2026-07-20' }))]

    const cells = bucketMonthChips(days, timed, allDay, TZ)
    const cell = cells.find((c) => c.date.toString() === '2026-07-20')!
    expect(cell.visible.map((c) => c.kind)).toEqual(['allday', 'timed'])
  })

  it('maxChipsPerCell を超えた分は overflowCount にまとめる', () => {
    const day = Temporal.PlainDate.from('2026-07-20')
    const dayStartMs = day.toZonedDateTime({ timeZone: TZ }).epochMilliseconds
    const groups = Array.from({ length: 6 }, (_, i) =>
      timedGroup(
        occ({
          id: `evt-${i}`,
          startMs: dayStartMs + i * 3600_000,
          endMs: dayStartMs + (i + 1) * 3600_000,
        }),
      ),
    )

    const cells = bucketMonthChips(days, groups, [], TZ, 4)
    const cell = cells.find((c) => c.date.toString() === '2026-07-20')!
    expect(cell.visible).toHaveLength(4)
    expect(cell.overflowCount).toBe(2)
  })

  it('チップが無い日は overflowCount=0・visible=[]', () => {
    const cells = bucketMonthChips(days, [], [], TZ)
    for (const cell of cells) {
      expect(cell.visible).toHaveLength(0)
      expect(cell.overflowCount).toBe(0)
    }
  })
})
