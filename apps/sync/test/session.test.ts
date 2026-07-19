import { describe, expect, it } from 'vitest'
import { createSessionCookieValue, verifySessionCookieValue } from '../src/session'

const SECRET = 'test-session-secret'
const PROFILE_ID = 'profile-123'
const DAY_MS = 24 * 60 * 60 * 1000

describe('session cookie', () => {
  it('verifies a session within its 30-day expiry', async () => {
    const issuedAt = Date.parse('2026-07-19T00:00:00Z')
    const sid = await createSessionCookieValue(SECRET, PROFILE_ID, issuedAt)

    const profileId = await verifySessionCookieValue(SECRET, sid, issuedAt + 1 * DAY_MS)

    expect(profileId).toBe(PROFILE_ID)
  })

  it('rejects a session past its 30-day expiry', async () => {
    const issuedAt = Date.parse('2026-07-19T00:00:00Z')
    const sid = await createSessionCookieValue(SECRET, PROFILE_ID, issuedAt)

    const profileId = await verifySessionCookieValue(SECRET, sid, issuedAt + 31 * DAY_MS)

    expect(profileId).toBeNull()
  })

  it('rejects a session with a tampered signature', async () => {
    const issuedAt = Date.parse('2026-07-19T00:00:00Z')
    const sid = await createSessionCookieValue(SECRET, PROFILE_ID, issuedAt)
    const lastChar = sid.at(-1)
    const tamperedChar = lastChar === 'a' ? 'b' : 'a'
    const tampered = sid.slice(0, -1) + tamperedChar

    const profileId = await verifySessionCookieValue(SECRET, tampered, issuedAt + 1 * DAY_MS)

    expect(profileId).toBeNull()
  })

  it('rejects the old 2-part format (profileId.signature, no expiry)', async () => {
    // 旧形式を模倣: 期限を含まない署名。マイグレーション不要でそのまま弾かれることを確認する。
    const legacySignature = 'deadbeef'
    const legacySid = `${PROFILE_ID}.${legacySignature}`

    const profileId = await verifySessionCookieValue(SECRET, legacySid)

    expect(profileId).toBeNull()
  })
})
