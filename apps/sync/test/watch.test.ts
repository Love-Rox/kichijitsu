import { describe, expect, it, vi } from 'vitest'
import { buildWebhookAddress, registerWatch, stopWatch } from '../src/google/watch'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('registerWatch', () => {
  it('POSTs to events.watch with the channel id/type/address/token and returns resourceId/expiration', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { resourceId: 'resource-1', expiration: '1700000000000' }))

    const result = await registerWatch(fetchImpl, 'access-token', {
      calendarId: 'primary',
      channelId: 'channel-1',
      address: 'https://kichijitsu.love-rox.cc/api/webhook/google',
      token: 'the-token',
    })

    expect(result).toEqual({ resourceId: 'resource-1', expiration: 1_700_000_000_000 })

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/watch')
    const requestInit = init as RequestInit
    expect(requestInit.method).toBe('POST')
    expect(JSON.parse(requestInit.body as string)).toEqual({
      id: 'channel-1',
      type: 'web_hook',
      address: 'https://kichijitsu.love-rox.cc/api/webhook/google',
      token: 'the-token',
    })
  })

  it('returns a null expiration when Google omits it', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(200, { resourceId: 'resource-1' }))

    const result = await registerWatch(fetchImpl, 'access-token', {
      calendarId: 'primary',
      channelId: 'channel-1',
      address: 'https://kichijitsu.love-rox.cc/api/webhook/google',
      token: 'the-token',
    })

    expect(result.expiration).toBeNull()
  })

  it('throws GoogleApiError on failure (e.g. unverified/localhost address, best-effort is handled by the caller)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('invalid address', { status: 400 }))

    await expect(
      registerWatch(fetchImpl, 'access-token', {
        calendarId: 'primary',
        channelId: 'channel-1',
        address: 'http://localhost:8787/api/webhook/google',
        token: 'the-token',
      }),
    ).rejects.toThrow(/400/)
  })
})

describe('stopWatch', () => {
  it('returns true when Google accepts the stop request', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 204 }))

    const result = await stopWatch(fetchImpl, 'access-token', { channelId: 'channel-1', resourceId: 'resource-1' })

    expect(result).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://www.googleapis.com/calendar/v3/channels/stop')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ id: 'channel-1', resourceId: 'resource-1' })
  })

  it('returns false (without throwing) when Google rejects the stop', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('not found', { status: 404 }))

    const result = await stopWatch(fetchImpl, 'access-token', { channelId: 'channel-1', resourceId: 'resource-1' })

    expect(result).toBe(false)
  })

  it('returns false (without throwing) on a network error', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('network down'))

    const result = await stopWatch(fetchImpl, 'access-token', { channelId: 'channel-1', resourceId: 'resource-1' })

    expect(result).toBe(false)
  })
})

describe('buildWebhookAddress', () => {
  it('appends the fixed webhook path to the base URL', () => {
    expect(buildWebhookAddress('https://kichijitsu.love-rox.cc')).toBe(
      'https://kichijitsu.love-rox.cc/api/webhook/google',
    )
  })
})
