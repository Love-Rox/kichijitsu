import { describe, expect, it } from 'vitest'
import { createSessionCookieValue, verifySessionCookieValue } from '../src/session'

const SECRET = 'test-session-secret'
const USER_ID = 'user-123'
const DAY_MS = 24 * 60 * 60 * 1000

describe('session cookie', () => {
  it('verifies a session within its 30-day expiry', async () => {
    const issuedAt = Date.parse('2026-07-19T00:00:00Z')
    const sid = await createSessionCookieValue(SECRET, USER_ID, issuedAt)

    const userId = await verifySessionCookieValue(SECRET, sid, issuedAt + 1 * DAY_MS)

    expect(userId).toBe(USER_ID)
  })

  it('rejects a session past its 30-day expiry', async () => {
    const issuedAt = Date.parse('2026-07-19T00:00:00Z')
    const sid = await createSessionCookieValue(SECRET, USER_ID, issuedAt)

    const userId = await verifySessionCookieValue(SECRET, sid, issuedAt + 31 * DAY_MS)

    expect(userId).toBeNull()
  })

  it('rejects a session with a tampered signature', async () => {
    const issuedAt = Date.parse('2026-07-19T00:00:00Z')
    const sid = await createSessionCookieValue(SECRET, USER_ID, issuedAt)
    const lastChar = sid.at(-1)
    const tamperedChar = lastChar === 'a' ? 'b' : 'a'
    const tampered = sid.slice(0, -1) + tamperedChar

    const userId = await verifySessionCookieValue(SECRET, tampered, issuedAt + 1 * DAY_MS)

    expect(userId).toBeNull()
  })

  it('rejects the old 2-part format (userId.signature, no expiry)', async () => {
    // 旧形式を模倣: 期限を含まない署名。マイグレーション不要でそのまま弾かれることを確認する。
    const legacySignature = 'deadbeef'
    const legacySid = `${USER_ID}.${legacySignature}`

    const userId = await verifySessionCookieValue(SECRET, legacySid)

    expect(userId).toBeNull()
  })
})
