import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attachServerEventListeners,
  createChangedDebouncer,
  parseServerEvent,
  type EventSourceLike,
} from './useServerEvents'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createChangedDebouncer', () => {
  it('同じキーの連投は最後の呼び出しから delayMs 後に1回だけ dispatch する', () => {
    const dispatch = vi.fn()
    const { schedule } = createChangedDebouncer(dispatch, 2000)

    schedule('acc-1', 'cal-1')
    vi.advanceTimersByTime(1000)
    schedule('acc-1', 'cal-1') // バースト: タイマーを延長するだけで dispatch は起きない
    vi.advanceTimersByTime(1000)
    expect(dispatch).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith('acc-1', 'cal-1')
  })

  it('異なるキーは独立してデバウンスされる', () => {
    const dispatch = vi.fn()
    const { schedule } = createChangedDebouncer(dispatch, 2000)

    schedule('acc-1', 'cal-1')
    vi.advanceTimersByTime(500)
    schedule('acc-2', 'cal-9')

    vi.advanceTimersByTime(1500)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith('acc-1', 'cal-1')

    vi.advanceTimersByTime(500)
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenCalledWith('acc-2', 'cal-9')
  })

  it('clear() は保留中のタイマーを全て止め、以後 dispatch されない', () => {
    const dispatch = vi.fn()
    const { schedule, clear } = createChangedDebouncer(dispatch, 2000)

    schedule('acc-1', 'cal-1')
    schedule('acc-2', 'cal-2')
    clear()
    vi.advanceTimersByTime(5000)

    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('parseServerEvent', () => {
  it('hello をパースする', () => {
    expect(parseServerEvent(JSON.stringify({ type: 'hello' }))).toEqual({ type: 'hello' })
  })

  it('changed をパースする', () => {
    expect(parseServerEvent(JSON.stringify({ type: 'changed', accountId: 'a', calendarId: 'c' }))).toEqual({
      type: 'changed',
      accountId: 'a',
      calendarId: 'c',
    })
  })

  it('不正な JSON は null を返す', () => {
    expect(parseServerEvent('not json')).toBeNull()
  })

  it('未知の type は null を返す', () => {
    expect(parseServerEvent(JSON.stringify({ type: 'other' }))).toBeNull()
  })

  it('changed で accountId/calendarId が欠けていれば null を返す', () => {
    expect(parseServerEvent(JSON.stringify({ type: 'changed', accountId: 'a' }))).toBeNull()
  })
})

/** テスト用の最小限 EventSource フェイク: addEventListener('message', ...) のみ実装する */
class FakeEventSource implements EventSourceLike {
  private listeners: ((event: MessageEvent) => void)[] = []

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.push(listener)
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener)
  }

  emit(data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent
    for (const listener of this.listeners) listener(event)
  }
}

describe('attachServerEventListeners', () => {
  it('hello メッセージで onHello を即座に呼ぶ', () => {
    const es = new FakeEventSource()
    const onHello = vi.fn()
    const onChanged = vi.fn()
    attachServerEventListeners(es, { onHello, onChanged })

    es.emit({ type: 'hello' })

    expect(onHello).toHaveBeenCalledTimes(1)
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('changed メッセージはデバウンスされてから onChanged を呼ぶ(即時には呼ばれない)', () => {
    const es = new FakeEventSource()
    const onHello = vi.fn()
    const onChanged = vi.fn()
    attachServerEventListeners(es, { onHello, onChanged })

    es.emit({ type: 'changed', accountId: 'acc-1', calendarId: 'cal-1' })
    expect(onChanged).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2000)
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(onChanged).toHaveBeenCalledWith('acc-1', 'cal-1')
    expect(onHello).not.toHaveBeenCalled()
  })

  it('壊れたメッセージは無視する', () => {
    const es = new FakeEventSource()
    const onHello = vi.fn()
    const onChanged = vi.fn()
    attachServerEventListeners(es, { onHello, onChanged })

    es.emit('not an object payload, will still be JSON.stringify-ed as a string')
    vi.advanceTimersByTime(2000)

    expect(onHello).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('デタッチ後は changed のバースト分も dispatch されない', () => {
    const es = new FakeEventSource()
    const onHello = vi.fn()
    const onChanged = vi.fn()
    const detach = attachServerEventListeners(es, { onHello, onChanged })

    es.emit({ type: 'changed', accountId: 'acc-1', calendarId: 'cal-1' })
    detach()
    vi.advanceTimersByTime(2000)

    expect(onChanged).not.toHaveBeenCalled()
  })
})
