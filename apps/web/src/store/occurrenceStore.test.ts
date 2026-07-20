import { describe, expect, it, vi } from 'vitest'
import { OccurrenceStore } from './occurrenceStore'
import type { Occurrence } from '../model/types'

function occ(id: string, startMs: number, endMs: number): Occurrence {
  return { id, seriesId: null, title: id, startMs, endMs, color: '#000', source: 'local' }
}

describe('OccurrenceStore', () => {
  it('load/remove/update はそれぞれ即座に1回通知する(バッチ外の既存挙動)', () => {
    const store = new OccurrenceStore()
    const listener = vi.fn()
    store.subscribe(listener)

    store.load([occ('a', 0, 1000)])
    expect(listener).toHaveBeenCalledTimes(1)

    store.update(occ('a', 0, 2000))
    expect(listener).toHaveBeenCalledTimes(2)

    store.remove(['a'])
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('batch 中は複数回 remove/load しても通知は抑止され、解除時に1回だけ通知される', async () => {
    const store = new OccurrenceStore()
    const listener = vi.fn()
    store.subscribe(listener)

    await store.batch(() => {
      store.remove(['nonexistent']) // 変化なしなので bump すら起きない
      store.load([occ('a', 0, 1000), occ('b', 1000, 2000)])
      store.remove(['a'])
      store.load([occ('c', 2000, 3000)])
      expect(listener).not.toHaveBeenCalled()
    })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getRange(0, 10_000).map((o) => o.id)).toEqual(['b', 'c'])
  })

  it('batch 中に一度も変化がなければ通知はゼロ回', async () => {
    const store = new OccurrenceStore()
    const listener = vi.fn()
    store.subscribe(listener)

    await store.batch(() => {
      store.remove(['nonexistent'])
    })

    expect(listener).not.toHaveBeenCalled()
  })

  it('ネストした batch は最外周が抜けたときにだけ1回通知する', async () => {
    const store = new OccurrenceStore()
    const listener = vi.fn()
    store.subscribe(listener)

    await store.batch(async () => {
      store.load([occ('a', 0, 1000)])
      await store.batch(() => {
        store.remove(['a'])
        store.load([occ('b', 0, 1000)])
        expect(listener).not.toHaveBeenCalled()
      })
      // 内側の batch が抜けても、外側がまだ進行中なので通知されない
      expect(listener).not.toHaveBeenCalled()
      store.load([occ('c', 1000, 2000)])
    })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getRange(0, 10_000).map((o) => o.id).sort()).toEqual(['b', 'c'])
  })

  it('async fn を伴う batch にも対応し、完了を待ってから1回だけ通知する', async () => {
    const store = new OccurrenceStore()
    const listener = vi.fn()
    store.subscribe(listener)

    await store.batch(async () => {
      store.load([occ('a', 0, 1000)])
      await new Promise((resolve) => setTimeout(resolve, 0))
      store.remove(['a'])
      store.load([occ('b', 0, 1000)])
      expect(listener).not.toHaveBeenCalled()
    })

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('fn が例外を投げても depth は正しく戻り、変化があれば通知してから rethrow する', async () => {
    const store = new OccurrenceStore()
    const listener = vi.fn()
    store.subscribe(listener)

    await expect(
      store.batch(() => {
        store.load([occ('a', 0, 1000)])
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(listener).toHaveBeenCalledTimes(1)

    // depth が壊れていなければ、次の batch も正常に1回だけ通知する
    listener.mockClear()
    await store.batch(() => {
      store.load([occ('b', 0, 1000)])
    })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('flush 後に getRange を呼ぶと最新 version の結果を返す(中間 version でキャッシュが固定されない)', async () => {
    const store = new OccurrenceStore()

    await store.batch(() => {
      store.load([occ('a', 0, 1000)])
      // batch 中でも version は上がるため、ここで getRange を呼ぶと
      // その時点の最新状態を返す(中間キャッシュが古いまま残ったりしない)
      expect(store.getRange(0, 10_000).map((o) => o.id)).toEqual(['a'])
      store.remove(['a'])
      store.load([occ('b', 0, 1000)])
    })

    expect(store.getRange(0, 10_000).map((o) => o.id)).toEqual(['b'])
  })
})
