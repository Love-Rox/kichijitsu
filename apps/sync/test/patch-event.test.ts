import { describe, expect, it, vi } from 'vitest'
import { patchEventTime, toRfc3339Utc } from '../src/google/patch-event'
import { patchEventTimeWithRetry, type PatchEventCoreDeps } from '../src/core/patch-event'

const PARAMS = {
  calendarId: 'primary',
  eventId: 'event-1',
  startMs: 1_700_000_000_000,
  endMs: 1_700_003_600_000,
  timeZone: 'Asia/Tokyo',
}

describe('toRfc3339Utc', () => {
  it('formats an epoch ms as a UTC RFC3339 string', () => {
    expect(toRfc3339Utc(1_700_000_000_000)).toBe('2023-11-14T22:13:20.000Z')
  })
})

describe('patchEventTime', () => {
  it('PATCHes events/{eventId} with start/end dateTime+timeZone and a bearer auth header', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 200 }))

    await patchEventTime(fetchImpl, 'access-token', PARAMS)

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/event-1')
    const requestInit = init as RequestInit
    expect(requestInit.method).toBe('PATCH')
    expect((requestInit.headers as Record<string, string>).Authorization).toBe('Bearer access-token')
    expect((requestInit.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(requestInit.body as string)).toEqual({
      start: { dateTime: toRfc3339Utc(PARAMS.startMs), timeZone: 'Asia/Tokyo' },
      end: { dateTime: toRfc3339Utc(PARAMS.endMs), timeZone: 'Asia/Tokyo' },
    })
  })

  it('URL-encodes calendarId and eventId', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 200 }))

    await patchEventTime(fetchImpl, 'access-token', {
      ...PARAMS,
      calendarId: 'a/b@example.com',
      eventId: 'event id with spaces',
    })

    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/a%2Fb%40example.com/events/event%20id%20with%20spaces',
    )
  })
})

interface DepsOverrides {
  accessToken?: string
}

function makeDeps(fetchImpl: typeof fetch, overrides: DepsOverrides = {}) {
  const forceRefreshAccessToken = vi.fn(async () => 'refreshed-access-token')
  const deps: PatchEventCoreDeps = {
    fetch: fetchImpl,
    getAccessToken: vi.fn(async () => overrides.accessToken ?? 'valid-access-token'),
    forceRefreshAccessToken,
  }
  return { deps, forceRefreshAccessToken }
}

describe('patchEventTimeWithRetry', () => {
  it('resolves without error on a successful patch', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 200 }))
    const { deps } = makeDeps(fetchImpl)

    await expect(patchEventTimeWithRetry(deps, PARAMS)).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('throws GoogleApiError (without retry) on a 404 (event gone)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('not found', { status: 404 }))
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl)

    await expect(patchEventTimeWithRetry(deps, PARAMS)).rejects.toThrow(/404/)
    expect(forceRefreshAccessToken).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('propagates 403/412 as GoogleApiError instead of swallowing them', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('precondition failed', { status: 412 }))
    const { deps } = makeDeps(fetchImpl)

    await expect(patchEventTimeWithRetry(deps, PARAMS)).rejects.toThrow(/412/)
  })

  it('refreshes the access token once on 401 and retries the same request', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl, { accessToken: 'stale-access-token' })

    await expect(patchEventTimeWithRetry(deps, PARAMS)).resolves.toBeUndefined()

    expect(forceRefreshAccessToken).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const firstAuth = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(firstAuth.Authorization).toBe('Bearer stale-access-token')
    const secondAuth = (fetchImpl.mock.calls[1][1] as RequestInit).headers as Record<string, string>
    expect(secondAuth.Authorization).toBe('Bearer refreshed-access-token')
  })

  it('gives up after a second 401 (only retries once)', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl)

    await expect(patchEventTimeWithRetry(deps, PARAMS)).rejects.toThrow(/401/)
    expect(forceRefreshAccessToken).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
