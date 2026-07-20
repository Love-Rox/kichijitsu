import { describe, expect, it } from 'vitest'
import {
  BUSY_FALLBACK_COLOR,
  UNKNOWN_CALENDAR_COLOR,
  buildCalendarStripeColors,
  isValidCssColor,
  resolveBusyColor,
  resolveEventColor,
  type CalendarColorInfo,
  type ColorLookupTarget,
} from './eventColors'

function target(overrides: Partial<ColorLookupTarget> = {}): ColorLookupTarget {
  return { accountId: 'acc-1', calendarId: 'cal-1', color: '#3b82f6', ...overrides }
}

describe('isValidCssColor', () => {
  it('3桁/6桁 hex を妥当と判定する', () => {
    expect(isValidCssColor('#fff')).toBe(true)
    expect(isValidCssColor('#3b82f6')).toBe(true)
    expect(isValidCssColor('#3B82F6')).toBe(true)
  })

  it('rgb/rgba/hsl/hsla 関数記法を妥当と判定する', () => {
    expect(isValidCssColor('rgb(59, 130, 246)')).toBe(true)
    expect(isValidCssColor('rgba(59, 130, 246, 0.5)')).toBe(true)
    expect(isValidCssColor('hsl(217, 91%, 60%)')).toBe(true)
    expect(isValidCssColor('hsla(217, 91%, 60%, 0.5)')).toBe(true)
  })

  it('未設定・空文字・不正な文字列を不正と判定する', () => {
    expect(isValidCssColor(undefined)).toBe(false)
    expect(isValidCssColor(null)).toBe(false)
    expect(isValidCssColor('')).toBe(false)
    expect(isValidCssColor('   ')).toBe(false)
    expect(isValidCssColor('not-a-color')).toBe(false)
    expect(isValidCssColor('#12')).toBe(false)
    expect(isValidCssColor('#12345')).toBe(false)
  })
})

describe('resolveEventColor', () => {
  it('calendarLookup にエントリがあればその backgroundColor を優先する', () => {
    const lookup = new Map<string, CalendarColorInfo>([['acc-1:cal-1', { backgroundColor: '#ff0000' }]])
    expect(resolveEventColor(target(), lookup)).toBe('#ff0000')
  })

  it('calendarLookup にエントリが無ければ target.color にフォールバックする', () => {
    const lookup = new Map<string, CalendarColorInfo>()
    expect(resolveEventColor(target({ color: '#00ff00' }), lookup)).toBe('#00ff00')
  })

  it('accountId/calendarId が無い(ローカルイベント等)場合も target.color を返す', () => {
    const lookup = new Map<string, CalendarColorInfo>([['acc-1:cal-1', { backgroundColor: '#ff0000' }]])
    expect(resolveEventColor(target({ accountId: undefined, calendarId: undefined, color: '#00ff00' }), lookup)).toBe(
      '#00ff00',
    )
  })
})

describe('resolveBusyColor', () => {
  it('解決した色が妥当ならそのまま使う', () => {
    const lookup = new Map<string, CalendarColorInfo>([['acc-1:cal-1', { backgroundColor: '#ff00aa' }]])
    expect(resolveBusyColor(target(), lookup)).toBe('#ff00aa')
  })

  it('occurrence.color のみでも妥当なら使う(calendarLookup 未登録)', () => {
    const lookup = new Map<string, CalendarColorInfo>()
    expect(resolveBusyColor(target({ color: '#123abc' }), lookup)).toBe('#123abc')
  })

  it('解決した色が不正/空なら従来のグレーにフォールバックする', () => {
    const lookup = new Map<string, CalendarColorInfo>()
    expect(resolveBusyColor(target({ color: '' }), lookup)).toBe(BUSY_FALLBACK_COLOR)
    expect(resolveBusyColor(target({ color: 'not-a-color' }), lookup)).toBe(BUSY_FALLBACK_COLOR)
  })
})

describe('buildCalendarStripeColors', () => {
  it('メンバー数が上限以下ならそれぞれの解決色をそのまま順番通りに返す', () => {
    const lookup = new Map<string, CalendarColorInfo>([
      ['acc-1:cal-1', { backgroundColor: '#111111' }],
      ['acc-2:cal-2', { backgroundColor: '#222222' }],
    ])
    const members = [target({ accountId: 'acc-1', calendarId: 'cal-1' }), target({ accountId: 'acc-2', calendarId: 'cal-2' })]

    expect(buildCalendarStripeColors(members, lookup)).toEqual(['#111111', '#222222'])
  })

  it('不正な色は UNKNOWN_CALENDAR_COLOR に丸める', () => {
    const lookup = new Map<string, CalendarColorInfo>()
    const members = [target({ color: 'garbage' })]

    expect(buildCalendarStripeColors(members, lookup)).toEqual([UNKNOWN_CALENDAR_COLOR])
  })

  it('上限を超えるメンバーは先頭 (maxStripes-1) 本を実色にし、最後の1本にまとめる', () => {
    const lookup = new Map<string, CalendarColorInfo>()
    const members = Array.from({ length: 7 }, (_, i) => target({ accountId: `acc-${i}`, calendarId: 'cal-1', color: `#${i}${i}${i}${i}${i}${i}` }))

    const result = buildCalendarStripeColors(members, lookup, 5)

    expect(result).toHaveLength(5)
    expect(result.slice(0, 4)).toEqual(['#000000', '#111111', '#222222', '#333333'])
    expect(result[4]).toBe(UNKNOWN_CALENDAR_COLOR)
  })

  it('メンバー1件でもそのまま1色の配列を返す(呼び出し側で単一メンバー時の描画有無を判断する)', () => {
    const lookup = new Map<string, CalendarColorInfo>()
    expect(buildCalendarStripeColors([target({ color: '#abcdef' })], lookup)).toEqual(['#abcdef'])
  })
})
