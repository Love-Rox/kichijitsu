import { describe, expect, it } from 'vitest'
import { decodeOAuthState, encodeOAuthState, type OAuthState } from '../src/oauth-state'

describe('encodeOAuthState / decodeOAuthState', () => {
  it('round-trips a login-mode state', () => {
    const state: OAuthState = { nonce: 'abc-123', mode: 'login' }
    const encoded = encodeOAuthState(state)

    expect(decodeOAuthState(encoded)).toEqual(state)
  })

  it('round-trips an add-mode state carrying the target profileId', () => {
    const state: OAuthState = { nonce: 'xyz-789', mode: 'add', profileId: 'profile-abc' }
    const encoded = encodeOAuthState(state)

    expect(decodeOAuthState(encoded)).toEqual(state)
  })

  it('produces a URL-safe opaque token (no raw JSON leaking into the query string)', () => {
    const encoded = encodeOAuthState({ nonce: 'n', mode: 'login' })
    expect(encoded).not.toMatch(/[{}":]/)
  })

  it('rejects garbage input', () => {
    expect(decodeOAuthState('not-valid-base64url-json!!!')).toBeNull()
    expect(decodeOAuthState('')).toBeNull()
  })

  it('rejects an add-mode payload missing profileId', () => {
    // "add" モードなのに profileId が無い、型システムを迂回した (バグ/改ざんを想定した) 入力
    const encoded = base64UrlEncodeJson({ nonce: 'n', mode: 'add' })

    expect(decodeOAuthState(encoded)).toBeNull()
  })

  it('rejects an unknown mode', () => {
    const encoded = base64UrlEncodeJson({ nonce: 'n', mode: 'evil' })

    expect(decodeOAuthState(encoded)).toBeNull()
  })
})

function base64UrlEncodeJson(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
