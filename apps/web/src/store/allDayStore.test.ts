import { describe, expect, it, vi } from 'vitest'
import { AllDayStore } from './allDayStore'
import type { AllDayOccurrence } from '../model/types'

function allDay(id: string, startDate: string, endDate = startDate): AllDayOccurrence {
  return { id, seriesId: null, title: id, startDate, endDate, color: '#000', source: 'local' }
}

describe('AllDayStore', () => {
  it('batch 外の remove/load は即座に通知する(既存挙動)', () => {
    const store = new AllDayStore()
    const listener = vi.fn()
    store.subscribe(listener)

    store.load([allDay('a', '2026-07-20')])
    expect(listener).toHaveBeenCalledTimes(1)

    store.remove(['a'])
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('batch 中の remove→load は1回の通知にまとまり、中間状態が観測されない', async () => {
    const store = new AllDayStore()
    const listener = vi.fn()
    store.subscribe(listener)

    store.load([allDay('a', '2026-07-20')])
    listener.mockClear()

    await store.batch(() => {
      store.remove(['a'])
      // batch 中: 一時的に空でも通知は起きていない
      expect(listener).not.toHaveBeenCalled()
      store.load([allDay('b', '2026-07-21')])
    })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getRange('2026-07-01', '2026-07-31').map((o) => o.id)).toEqual(['b'])
  })

  it('batch 内で変化がなければ通知はゼロ回', async () => {
    const store = new AllDayStore()
    const listener = vi.fn()
    store.subscribe(listener)

    await store.batch(() => {
      store.remove(['nonexistent'])
    })

    expect(listener).not.toHaveBeenCalled()
  })

  it('ネストした batch でも最外周が抜けたときに1回だけ通知する', async () => {
    const store = new AllDayStore()
    const listener = vi.fn()
    store.subscribe(listener)

    await store.batch(async () => {
      await store.batch(() => {
        store.load([allDay('a', '2026-07-20')])
      })
      expect(listener).not.toHaveBeenCalled()
      store.load([allDay('b', '2026-07-21')])
    })

    expect(listener).toHaveBeenCalledTimes(1)
  })
})
