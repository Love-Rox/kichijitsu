import { describe, expect, it } from 'vitest'
import type { AllDayOccurrence, Occurrence } from '../model/types'
import { groupDuplicateAllDayOccurrences, groupDuplicateOccurrences } from './groupDuplicates'

function occ(overrides: Partial<Occurrence> = {}): Occurrence {
  return {
    id: 'g:acc-1:cal-1:evt-1',
    seriesId: null,
    title: 'Test Event',
    startMs: 1_000,
    endMs: 2_000,
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

describe('groupDuplicateOccurrences', () => {
  it('iCalUID + startMs + endMs が一致するコピーを1グループにまとめる', () => {
    const a = occ({ id: 'g:acc-1:cal-1:evt-a', accountId: 'acc-1', calendarId: 'cal-1', iCalUID: 'uid-1' })
    const b = occ({ id: 'g:acc-2:cal-2:evt-b', accountId: 'acc-2', calendarId: 'cal-2', iCalUID: 'uid-1' })

    const groups = groupDuplicateOccurrences([a, b])

    expect(groups).toHaveLength(1)
    expect(groups[0].members).toHaveLength(2)
    expect(groups[0].members.map((m) => m.id).sort()).toEqual(['g:acc-1:cal-1:evt-a', 'g:acc-2:cal-2:evt-b'])
  })

  it('primary はグループ内で accountId→calendarId 昇順の先頭コピー', () => {
    const later = occ({ id: 'g:acc-z:cal-1:evt-a', accountId: 'acc-z', calendarId: 'cal-1', iCalUID: 'uid-1' })
    const earlier = occ({ id: 'g:acc-a:cal-1:evt-b', accountId: 'acc-a', calendarId: 'cal-1', iCalUID: 'uid-1' })

    // 入力順は later が先でも、primary は accountId 昇順で先頭の earlier になる
    const groups = groupDuplicateOccurrences([later, earlier])

    expect(groups).toHaveLength(1)
    expect(groups[0].primary.id).toBe('g:acc-a:cal-1:evt-b')
  })

  it('同じ accountId なら calendarId 昇順で primary を決める', () => {
    const b = occ({ id: 'g:acc-1:cal-b:evt-1', accountId: 'acc-1', calendarId: 'cal-b', iCalUID: 'uid-1' })
    const a = occ({ id: 'g:acc-1:cal-a:evt-2', accountId: 'acc-1', calendarId: 'cal-a', iCalUID: 'uid-1' })

    const groups = groupDuplicateOccurrences([b, a])

    expect(groups[0].primary.id).toBe('g:acc-1:cal-a:evt-2')
  })

  it('iCalUID が一致していても時刻が違えば別グループにする', () => {
    const a = occ({ id: 'g:acc-1:cal-1:evt-a', iCalUID: 'uid-1', startMs: 1_000, endMs: 2_000 })
    const b = occ({ id: 'g:acc-2:cal-2:evt-b', iCalUID: 'uid-1', startMs: 5_000, endMs: 6_000 })

    const groups = groupDuplicateOccurrences([a, b])

    expect(groups).toHaveLength(2)
    expect(groups.every((g) => g.members.length === 1)).toBe(true)
  })

  it('iCalUID が無い occurrence は集約せず単独グループのまま', () => {
    const a = occ({ id: 'g:acc-1:cal-1:evt-a', iCalUID: undefined })
    const b = occ({ id: 'g:acc-2:cal-2:evt-b', iCalUID: undefined })

    const groups = groupDuplicateOccurrences([a, b])

    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.primary.id).sort()).toEqual(['g:acc-1:cal-1:evt-a', 'g:acc-2:cal-2:evt-b'])
    for (const g of groups) {
      expect(g.members).toEqual([g.primary])
    }
  })

  it('ローカルイベント (iCalUID なし) も単独グループとして扱われる', () => {
    const local = occ({
      id: 'local-1',
      source: 'local',
      accountId: undefined,
      calendarId: undefined,
      iCalUID: undefined,
    })

    const groups = groupDuplicateOccurrences([local])

    expect(groups).toHaveLength(1)
    expect(groups[0]).toEqual({ primary: local, members: [local] })
  })

  it('単独 occurrence(重複なし)の members は primary 自身のみを含む1件配列', () => {
    const a = occ({ id: 'g:acc-1:cal-1:evt-a', iCalUID: 'uid-only-once' })

    const groups = groupDuplicateOccurrences([a])

    expect(groups).toHaveLength(1)
    expect(groups[0].primary).toBe(a)
    expect(groups[0].members).toEqual([a])
  })
})

describe('groupDuplicateAllDayOccurrences', () => {
  it('iCalUID + startDate + endDate が一致するコピーを1グループにまとめる', () => {
    const a = allDayOcc({ id: 'g:acc-1:cal-1:holiday-a', accountId: 'acc-1', calendarId: 'cal-1', iCalUID: 'uid-1' })
    const b = allDayOcc({ id: 'g:acc-2:cal-2:holiday-b', accountId: 'acc-2', calendarId: 'cal-2', iCalUID: 'uid-1' })

    const groups = groupDuplicateAllDayOccurrences([a, b])

    expect(groups).toHaveLength(1)
    expect(groups[0].members).toHaveLength(2)
    expect(groups[0].primary.id).toBe('g:acc-1:cal-1:holiday-a') // accountId 昇順
  })

  it('日付が違えば別グループにする', () => {
    const a = allDayOcc({ id: 'g:acc-1:cal-1:holiday-a', iCalUID: 'uid-1', startDate: '2026-07-20', endDate: '2026-07-20' })
    const b = allDayOcc({ id: 'g:acc-2:cal-2:holiday-b', iCalUID: 'uid-1', startDate: '2026-08-11', endDate: '2026-08-11' })

    const groups = groupDuplicateAllDayOccurrences([a, b])

    expect(groups).toHaveLength(2)
  })

  it('iCalUID が無い終日予定は集約せず単独グループのまま', () => {
    const a = allDayOcc({ id: 'g:acc-1:cal-1:holiday-a', iCalUID: undefined })

    const groups = groupDuplicateAllDayOccurrences([a])

    expect(groups).toEqual([{ primary: a, members: [a] }])
  })
})
