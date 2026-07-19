import { describe, expect, it } from 'vitest'
import { computeChannelToken, timingSafeEqual } from '../src/watch-token'

const SECRET_A = 'CrHsQtGu/PWgNHz5b7oudGE0Ib889ulb4rs/Vw4jd48='
const SECRET_B = 'ZmFrZS1rZXktZm9yLXRlc3RpbmctMzItYnl0ZXMhISE='

describe('computeChannelToken', () => {
  it('is deterministic for the same secret and channelId', async () => {
    const a = await computeChannelToken(SECRET_A, 'channel-1')
    const b = await computeChannelToken(SECRET_A, 'channel-1')
    expect(a).toBe(b)
  })

  it('differs across channelIds (so a stolen token cannot be replayed for another channel)', async () => {
    const a = await computeChannelToken(SECRET_A, 'channel-1')
    const b = await computeChannelToken(SECRET_A, 'channel-2')
    expect(a).not.toBe(b)
  })

  it('differs across secrets', async () => {
    const a = await computeChannelToken(SECRET_A, 'channel-1')
    const b = await computeChannelToken(SECRET_B, 'channel-1')
    expect(a).not.toBe(b)
  })

  it('is truncated to 16 characters', async () => {
    const token = await computeChannelToken(SECRET_A, 'channel-1')
    expect(token).toHaveLength(16)
  })
})

describe('timingSafeEqual', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true)
  })

  it('returns false for different strings of the same length', () => {
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false)
  })

  it('returns false for different lengths', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
  })
})
