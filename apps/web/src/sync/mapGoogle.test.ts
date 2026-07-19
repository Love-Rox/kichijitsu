import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Temporal } from '@js-temporal/polyfill'
import type { GoogleEventDTO } from '@hiyori/shared'
import { mapGoogleEvents } from './mapGoogle'
import { instanceId } from '../model/series'

function zms(iso: string, timeZone: string): number {
  return Temporal.PlainDateTime.from(iso).toZonedDateTime(timeZone).epochMilliseconds
}

function baseEvent(overrides: Partial<GoogleEventDTO> = {}): GoogleEventDTO {
  return {
    id: 'evt-1',
    status: 'confirmed',
    summary: 'Test Event',
    start: { dateTime: '2026-07-20T10:00:00+09:00', timeZone: 'Asia/Tokyo' },
    end: { dateTime: '2026-07-20T11:00:00+09:00', timeZone: 'Asia/Tokyo' },
    ...overrides,
  }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('mapGoogleEvents', () => {
  it('繰り返しの親イベントを EventSeries に変換し、TZID付き EXDATE をパースする', () => {
    const event = baseEvent({
      id: 'series-evt',
      recurrence: [
        'RRULE:FREQ=WEEKLY;BYDAY=MO,WE',
        'EXDATE;TZID=Asia/Tokyo:20260720T100000',
      ],
    })

    const result = mapGoogleEvents([event])

    expect(result.series).toHaveLength(1)
    const series = result.series[0]
    expect(series.id).toBe('g:series-evt')
    expect(series.dtstartIso).toBe('2026-07-20T10:00')
    expect(series.timeZone).toBe('Asia/Tokyo')
    expect(series.durationMin).toBe(60)
    expect(series.rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE')
    expect(series.exdatesMs).toEqual([zms('2026-07-20T10:00', 'Asia/Tokyo')])
    expect(series.source).toBe('google')
    expect(result.overrides).toHaveLength(0)
    expect(result.singles).toHaveLength(0)
  })

  it('UTC (Z サフィックス) の EXDATE もパースする', () => {
    const event = baseEvent({
      id: 'series-utc',
      recurrence: ['RRULE:FREQ=DAILY', 'EXDATE:20260720T010000Z'],
    })

    const result = mapGoogleEvents([event])

    expect(result.series[0].exdatesMs).toEqual([
      Temporal.ZonedDateTime.from({
        timeZone: 'UTC',
        year: 2026,
        month: 7,
        day: 20,
        hour: 1,
        minute: 0,
        second: 0,
      }).toInstant().epochMilliseconds,
    ])
  })

  it('カンマ区切りの複数 EXDATE 値をパースする', () => {
    const event = baseEvent({
      id: 'series-multi',
      recurrence: [
        'RRULE:FREQ=DAILY',
        'EXDATE;TZID=Asia/Tokyo:20260720T100000,20260722T100000',
      ],
    })

    const result = mapGoogleEvents([event])

    expect(result.series[0].exdatesMs).toEqual([
      zms('2026-07-20T10:00', 'Asia/Tokyo'),
      zms('2026-07-22T10:00', 'Asia/Tokyo'),
    ])
  })

  it('cancelled な例外インスタンスを patch:null の InstanceOverride に変換する', () => {
    const event = baseEvent({
      id: 'exception-1',
      status: 'cancelled',
      recurringEventId: 'series-evt',
      originalStartTime: { dateTime: '2026-07-27T10:00:00+09:00', timeZone: 'Asia/Tokyo' },
      start: undefined,
      end: undefined,
    })

    const result = mapGoogleEvents([event])

    expect(result.overrides).toHaveLength(1)
    const override = result.overrides[0]
    const originalStartMs = zms('2026-07-27T10:00', 'Asia/Tokyo')
    expect(override.seriesId).toBe('g:series-evt')
    expect(override.originalStartMs).toBe(originalStartMs)
    expect(override.id).toBe(instanceId('g:series-evt', originalStartMs))
    expect(override.patch).toBeNull()
  })

  it('時刻変更された例外インスタンスを patch 付き InstanceOverride に変換する', () => {
    const event = baseEvent({
      id: 'exception-2',
      recurringEventId: 'series-evt',
      summary: 'Rescheduled',
      originalStartTime: { dateTime: '2026-07-27T10:00:00+09:00', timeZone: 'Asia/Tokyo' },
      start: { dateTime: '2026-07-27T14:00:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-07-27T15:00:00+09:00', timeZone: 'Asia/Tokyo' },
    })

    const result = mapGoogleEvents([event])

    expect(result.overrides).toHaveLength(1)
    const override = result.overrides[0]
    expect(override.patch).toEqual({
      title: 'Rescheduled',
      startMs: zms('2026-07-27T14:00', 'Asia/Tokyo'),
      endMs: zms('2026-07-27T15:00', 'Asia/Tokyo'),
    })
  })

  it('単発イベントを Occurrence に変換する', () => {
    const event = baseEvent({
      id: 'single-1',
      summary: 'Lunch',
      colorId: '5',
      htmlLink: 'https://calendar.google.com/event?eid=abc',
    })

    const result = mapGoogleEvents([event])

    expect(result.singles).toHaveLength(1)
    const occ = result.singles[0]
    expect(occ.id).toBe('g:single-1')
    expect(occ.seriesId).toBeNull()
    expect(occ.title).toBe('Lunch')
    expect(occ.startMs).toBe(zms('2026-07-20T10:00', 'Asia/Tokyo'))
    expect(occ.endMs).toBe(zms('2026-07-20T11:00', 'Asia/Tokyo'))
    expect(occ.color).toBe('#f6bf26')
    expect(occ.source).toBe('google')
    expect(occ.link).toEqual({ url: 'https://calendar.google.com/event?eid=abc' })
  })

  it('cancelled な単発イベントは deletedSingleIds に入る', () => {
    const event = baseEvent({ id: 'single-cancelled', status: 'cancelled' })

    const result = mapGoogleEvents([event])

    expect(result.singles).toHaveLength(0)
    expect(result.deletedSingleIds).toEqual(['g:single-cancelled'])
  })

  it('終日イベント (start.date のみ) は skippedAllDay をインクリメントしてスキップする', () => {
    const event = baseEvent({
      id: 'allday-1',
      start: { date: '2026-07-20' },
      end: { date: '2026-07-21' },
    })

    const result = mapGoogleEvents([event])

    expect(result.singles).toHaveLength(0)
    expect(result.series).toHaveLength(0)
    expect(result.skippedAllDay).toBe(1)
    expect(console.info).toHaveBeenCalled()
  })

  it('未対応の recurrence 行 (RDATE 等) は行単位でスキップし、RRULE は活かす', () => {
    const event = baseEvent({
      id: 'series-rdate',
      recurrence: ['RRULE:FREQ=DAILY', 'RDATE:20260801T100000Z'],
    })

    const result = mapGoogleEvents([event])

    expect(result.series).toHaveLength(1)
    expect(result.series[0].rrule).toBe('FREQ=DAILY')
    expect(console.warn).toHaveBeenCalled()
  })

  it('RRULE 行が無い recurrence は series ごとスキップする (warn する)', () => {
    const event = baseEvent({
      id: 'series-no-rrule',
      recurrence: ['EXDATE;TZID=Asia/Tokyo:20260720T100000'],
    })

    const result = mapGoogleEvents([event])

    expect(result.series).toHaveLength(0)
    expect(console.warn).toHaveBeenCalled()
  })

  it('壊れた EXDATE 値は行単位でスキップし、シリーズ自体は変換を続ける', () => {
    const event = baseEvent({
      id: 'series-bad-exdate',
      recurrence: ['RRULE:FREQ=DAILY', 'EXDATE;TZID=Asia/Tokyo:not-a-date'],
    })

    const result = mapGoogleEvents([event])

    expect(result.series).toHaveLength(1)
    expect(result.series[0].exdatesMs).toEqual([])
    expect(console.warn).toHaveBeenCalled()
  })

  it('1件の変換失敗は他のイベントを巻き込まない', () => {
    const broken = baseEvent({
      id: 'broken-exception',
      recurringEventId: 'series-evt',
      originalStartTime: undefined,
    })
    const healthy = baseEvent({ id: 'healthy-single' })

    const result = mapGoogleEvents([broken, healthy])

    expect(result.overrides).toHaveLength(0)
    expect(result.singles).toHaveLength(1)
    expect(result.singles[0].id).toBe('g:healthy-single')
    expect(console.warn).toHaveBeenCalled()
  })
})
