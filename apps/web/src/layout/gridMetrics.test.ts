import { describe, expect, it } from 'vitest'
import { overlapsBusy, type TimeInterval } from './gridMetrics'

function occ(startMs: number, endMs: number) {
  return { startMs, endMs }
}

describe('overlapsBusy', () => {
  it('busy 区間と部分的に重なれば true', () => {
    const busy: TimeInterval[] = [{ startMs: 100, endMs: 200 }]
    expect(overlapsBusy(occ(150, 250), busy)).toBe(true)
    expect(overlapsBusy(occ(50, 150), busy)).toBe(true)
  })

  it('busy 区間を完全に内包/内包されていれば true', () => {
    const busy: TimeInterval[] = [{ startMs: 100, endMs: 200 }]
    expect(overlapsBusy(occ(0, 300), busy)).toBe(true)
    expect(overlapsBusy(occ(120, 180), busy)).toBe(true)
  })

  it('端が接するだけ(重なりなし)は false', () => {
    const busy: TimeInterval[] = [{ startMs: 100, endMs: 200 }]
    expect(overlapsBusy(occ(0, 100), busy)).toBe(false)
    expect(overlapsBusy(occ(200, 300), busy)).toBe(false)
  })

  it('busy 区間と完全に離れていれば false', () => {
    const busy: TimeInterval[] = [{ startMs: 100, endMs: 200 }]
    expect(overlapsBusy(occ(300, 400), busy)).toBe(false)
    expect(overlapsBusy(occ(0, 50), busy)).toBe(false)
  })

  it('busy 区間が複数あるとき、どれか1つとでも重なれば true', () => {
    const busy: TimeInterval[] = [
      { startMs: 0, endMs: 50 },
      { startMs: 300, endMs: 400 },
    ]
    expect(overlapsBusy(occ(350, 360), busy)).toBe(true)
  })

  it('busy 区間が空なら常に false', () => {
    expect(overlapsBusy(occ(0, 100), [])).toBe(false)
  })
})
