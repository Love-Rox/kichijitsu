import { describe, expect, it } from 'vitest'
import { SseRingBuffer } from '../src/core/sse-ring-buffer'

function changed(calendarId: string) {
  return { type: 'changed' as const, accountId: 'acc-1', calendarId }
}

describe('SseRingBuffer', () => {
  it('assigns monotonically increasing ids starting at 1', () => {
    const buffer = new SseRingBuffer()
    const first = buffer.push(changed('cal-1'))
    const second = buffer.push(changed('cal-2'))

    expect(first.id).toBe(1)
    expect(second.id).toBe(2)
  })

  it('since() returns only events newer than the given id, oldest first', () => {
    const buffer = new SseRingBuffer()
    buffer.push(changed('cal-1')) // id 1
    buffer.push(changed('cal-2')) // id 2
    buffer.push(changed('cal-3')) // id 3

    const missed = buffer.since(1)

    expect(missed.map((e) => e.id)).toEqual([2, 3])
    expect(missed.map((e) => e.event.type === 'changed' && e.event.calendarId)).toEqual(['cal-2', 'cal-3'])
  })

  it('since() returns an empty array when the caller is already caught up', () => {
    const buffer = new SseRingBuffer()
    buffer.push(changed('cal-1'))

    expect(buffer.since(1)).toEqual([])
  })

  it('since() is best-effort when lastEventId is older than everything still buffered (evicted)', () => {
    const buffer = new SseRingBuffer(2)
    buffer.push(changed('cal-1')) // id 1, evicted below
    buffer.push(changed('cal-2')) // id 2
    buffer.push(changed('cal-3')) // id 3

    // id 1 was evicted (capacity 2), but asking for anything > 0 just returns what remains
    const missed = buffer.since(0)
    expect(missed.map((e) => e.id)).toEqual([2, 3])
  })

  it('evicts the oldest entries once capacity is exceeded', () => {
    const buffer = new SseRingBuffer(2)
    buffer.push(changed('cal-1'))
    buffer.push(changed('cal-2'))
    buffer.push(changed('cal-3'))

    // cal-1 (id 1) should have been evicted; since(0) only sees what remains
    const remaining = buffer.since(0)
    expect(remaining.map((e) => e.id)).toEqual([2, 3])
  })
})
