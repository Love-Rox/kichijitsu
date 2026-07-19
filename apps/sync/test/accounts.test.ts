import { describe, expect, it } from 'vitest'
import { isAccountInProfile, resolveDisconnectTargets, shouldClearSessionAfterDisconnect } from '../src/accounts'

describe('isAccountInProfile', () => {
  it('allows an account that belongs to the caller profile', () => {
    expect(isAccountInProfile({ profile_id: 'profile-a' }, 'profile-a')).toBe(true)
  })

  it('rejects an account that belongs to a different profile', () => {
    expect(isAccountInProfile({ profile_id: 'profile-b' }, 'profile-a')).toBe(false)
  })

  it('rejects a non-existent account (null row)', () => {
    expect(isAccountInProfile(null, 'profile-a')).toBe(false)
  })
})

describe('resolveDisconnectTargets', () => {
  const PROFILE_ACCOUNTS = ['acc-1', 'acc-2']

  it('targets just the requested account when it belongs to the profile', () => {
    expect(resolveDisconnectTargets({ accountId: 'acc-1' }, PROFILE_ACCOUNTS)).toEqual(['acc-1'])
  })

  it('returns null (ownership failure) when the requested account is not in the profile', () => {
    expect(resolveDisconnectTargets({ accountId: 'someone-elses-account' }, PROFILE_ACCOUNTS)).toBeNull()
  })

  it('targets every account in the profile when accountId is omitted', () => {
    expect(resolveDisconnectTargets({}, PROFILE_ACCOUNTS)).toEqual(PROFILE_ACCOUNTS)
  })
})

describe('shouldClearSessionAfterDisconnect', () => {
  it('keeps the session when at least one account remains (single-account disconnect)', () => {
    expect(shouldClearSessionAfterDisconnect(1)).toBe(false)
  })

  it('clears the session when no accounts remain (full disconnect)', () => {
    expect(shouldClearSessionAfterDisconnect(0)).toBe(true)
  })
})
