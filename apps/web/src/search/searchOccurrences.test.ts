import { describe, expect, it } from 'vitest'
import { searchOccurrences } from './searchOccurrences'
import type { AllDayOccurrence, Occurrence } from '../model/types'

function occ(partial: Partial<Occurrence> & { id: string; startMs: number }): Occurrence {
  return {
    seriesId: null,
    title: partial.id,
    endMs: partial.startMs + 60_000,
    color: '#000',
    source: 'local',
    ...partial,
  }
}

function allDay(partial: Partial<AllDayOccurrence> & { id: string; startDate: string }): AllDayOccurrence {
  return {
    seriesId: null,
    title: partial.id,
    endDate: partial.startDate,
    color: '#000',
    source: 'local',
    ...partial,
  }
}

const NOW = Date.UTC(2026, 6, 20, 0, 0, 0) // 2026-07-20T00:00:00Z

describe('searchOccurrences', () => {
  it('タイトルの部分一致(大文字小文字無視)でヒットする', () => {
    const occs = [occ({ id: 'a', startMs: 1000, title: 'Team Standup' })]
    const results = searchOccurrences('standup', occs, [], { now: NOW })
    expect(results.map((r) => r.occurrence.id)).toEqual(['a'])
  })

  it('場所・説明でもヒットする(フィールド横断)', () => {
    const occs = [
      occ({ id: 'loc', startMs: 1000, title: '会議', location: '会議室 Sakura' }),
      occ({ id: 'desc', startMs: 2000, title: '打ち合わせ', description: 'Sakura の議題について' }),
      occ({ id: 'none', startMs: 3000, title: '無関係' }),
    ]
    const results = searchOccurrences('sakura', occs, [], { now: NOW })
    expect(results.map((r) => r.occurrence.id).sort()).toEqual(['desc', 'loc'])
  })

  it('全角/半角を最小限吸収する(NFKC 正規化)', () => {
    const occs = [occ({ id: 'a', startMs: 1000, title: 'ＡＢＣテスト' })]
    const results = searchOccurrences('abc', occs, [], { now: NOW })
    expect(results.map((r) => r.occurrence.id)).toEqual(['a'])
  })

  it('時刻予定・終日予定の両方を横断し、開始時刻の昇順で返す', () => {
    const occs = [occ({ id: 'late', startMs: Date.UTC(2026, 6, 15), title: 'match' })]
    const allDays = [
      allDay({ id: 'early', startDate: '2026-07-01', title: 'match all day' }),
      allDay({ id: 'mid', startDate: '2026-07-10', title: 'match too' }),
    ]
    const results = searchOccurrences('match', occs, allDays, { now: NOW })
    expect(results.map((r) => r.occurrence.id)).toEqual(['early', 'mid', 'late'])
  })

  it('上限件数を超えるヒットは切り詰められる', () => {
    const occs = Array.from({ length: 10 }, (_, i) => occ({ id: `e${i}`, startMs: i * 1000, title: 'match' }))
    const results = searchOccurrences('match', occs, [], { now: NOW, limit: 3 })
    expect(results).toHaveLength(3)
    expect(results.map((r) => r.occurrence.id)).toEqual(['e0', 'e1', 'e2'])
  })

  it('visibleCalendarKeys 指定時、Google 由来はキーに含まれるものだけ・ローカルは常に対象', () => {
    const occs = [
      occ({ id: 'local', startMs: 1000, title: 'match local', source: 'local' }),
      occ({
        id: 'visible-google',
        startMs: 2000,
        title: 'match visible',
        source: 'google',
        accountId: 'acc1',
        calendarId: 'cal1',
      }),
      occ({
        id: 'hidden-google',
        startMs: 3000,
        title: 'match hidden',
        source: 'google',
        accountId: 'acc1',
        calendarId: 'cal2',
      }),
    ]
    const results = searchOccurrences('match', occs, [], {
      now: NOW,
      visibleCalendarKeys: new Set(['acc1:cal1']),
    })
    expect(results.map((r) => r.occurrence.id).sort()).toEqual(['local', 'visible-google'])
  })

  it('ヒット0件なら空配列を返す', () => {
    const occs = [occ({ id: 'a', startMs: 1000, title: 'foo' })]
    expect(searchOccurrences('nomatch', occs, [], { now: NOW })).toEqual([])
  })

  it('空クエリ時は現在時刻以降の近日予定を優先して返す', () => {
    const occs = [
      occ({ id: 'past', startMs: NOW - 5 * 24 * 60 * 60 * 1000, title: '過去' }),
      occ({ id: 'soon', startMs: NOW + 1000, title: '近日1' }),
      occ({ id: 'later', startMs: NOW + 2000, title: '近日2' }),
    ]
    const results = searchOccurrences('', occs, [], { now: NOW, emptyQueryLimit: 2 })
    expect(results.map((r) => r.occurrence.id)).toEqual(['soon', 'later'])
  })

  it('空クエリ時、近日予定が足りなければ直近の過去で時系列順に埋め合わせる', () => {
    const occs = [
      occ({ id: 'past2', startMs: NOW - 2000, title: '過去2' }),
      occ({ id: 'past1', startMs: NOW - 1000, title: '過去1' }),
      occ({ id: 'soon', startMs: NOW + 1000, title: '近日' }),
    ]
    const results = searchOccurrences('', occs, [], { now: NOW, emptyQueryLimit: 3 })
    expect(results.map((r) => r.occurrence.id)).toEqual(['past2', 'past1', 'soon'])
  })

  it('クエリのトリム: 空白のみは空クエリ扱いになる', () => {
    const occs = [occ({ id: 'soon', startMs: NOW + 1000, title: '近日' })]
    const results = searchOccurrences('   ', occs, [], { now: NOW, emptyQueryLimit: 5 })
    expect(results.map((r) => r.occurrence.id)).toEqual(['soon'])
  })
})
