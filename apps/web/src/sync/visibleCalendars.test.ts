import { describe, expect, it } from 'vitest'
import { buildVisibleCalendarsRequest, mergeServerVisibleCalendars } from './visibleCalendars'

describe('mergeServerVisibleCalendars', () => {
  it('サーバーに configured なエントリはサーバー側の値を採用する', () => {
    const local = { 'acc-1': ['local-only'] }
    const server = { 'acc-1': ['cal-a', 'cal-b'] }
    expect(mergeServerVisibleCalendars(local, server)).toEqual({ 'acc-1': ['cal-a', 'cal-b'] })
  })

  it('サーバーが空配列 (全部外した意思) でも尊重してローカルの非空値を上書きする', () => {
    const local = { 'acc-1': ['cal-a'] }
    const server = { 'acc-1': [] }
    expect(mergeServerVisibleCalendars(local, server)).toEqual({ 'acc-1': [] })
  })

  it('サーバーに無いアカウント (未設定) はローカルの値をそのまま残す', () => {
    const local = { 'acc-1': ['cal-a'], 'acc-2': ['cal-b'] }
    const server = { 'acc-1': ['cal-a'] }
    expect(mergeServerVisibleCalendars(local, server)).toEqual({ 'acc-1': ['cal-a'], 'acc-2': ['cal-b'] })
  })

  it('ローカルに無いアカウントでもサーバーに configured ならエントリを追加する', () => {
    const local = {}
    const server = { 'acc-1': ['cal-a'] }
    expect(mergeServerVisibleCalendars(local, server)).toEqual({ 'acc-1': ['cal-a'] })
  })

  it('両方空なら空を返す', () => {
    expect(mergeServerVisibleCalendars({}, {})).toEqual({})
  })

  it('呼び出し順序に依存しない ({ ...local, ...server } と等価)', () => {
    const local = { 'acc-1': ['stale'], 'acc-2': ['kept'] }
    const server = { 'acc-1': ['fresh'] }
    const result = mergeServerVisibleCalendars(local, server)
    expect(result).toEqual({ ...local, ...server })
  })
})

describe('buildVisibleCalendarsRequest', () => {
  it('accountId と calendarIds をそのまま VisibleCalendarsRequest に詰める', () => {
    expect(buildVisibleCalendarsRequest('acc-1', ['cal-a', 'cal-b'])).toEqual({
      accountId: 'acc-1',
      calendarIds: ['cal-a', 'cal-b'],
    })
  })

  it('空配列 (全部外した意思) もそのまま渡す', () => {
    expect(buildVisibleCalendarsRequest('acc-1', [])).toEqual({ accountId: 'acc-1', calendarIds: [] })
  })
})
