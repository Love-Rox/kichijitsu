import { describe, expect, it, vi } from 'vitest'
import { decideWebhookAction, type WatchRow } from '../src/core/webhook'

function makeWatch(overrides: Partial<WatchRow> = {}): WatchRow {
  return {
    channel_id: 'channel-1',
    resource_id: 'resource-1',
    account_id: 'acc-1',
    calendar_id: 'primary',
    profile_id: 'profile-1',
    expiration_ms: Date.now() + 1_000_000,
    created_at: Date.now(),
    ...overrides,
  }
}

describe('decideWebhookAction', () => {
  it('notifies when the channel token matches (valid notification)', async () => {
    const computeExpectedToken = vi.fn(async () => 'correct-token')
    const watch = makeWatch()

    const decision = await decideWebhookAction(computeExpectedToken, watch, 'channel-1', 'correct-token', 'exists')

    expect(decision).toEqual({
      action: 'notify',
      accountId: 'acc-1',
      calendarId: 'primary',
      profileId: 'profile-1',
    })
    expect(computeExpectedToken).toHaveBeenCalledWith('channel-1')
  })

  it('rejects when the channel token does not match (forged/incorrect token)', async () => {
    const computeExpectedToken = vi.fn(async () => 'correct-token')
    const watch = makeWatch()

    const decision = await decideWebhookAction(computeExpectedToken, watch, 'channel-1', 'wrong-token', 'exists')

    expect(decision).toEqual({ action: 'reject' })
  })

  it('rejects when the channel is unknown (no matching watches row, watch === null)', async () => {
    const computeExpectedToken = vi.fn(async () => 'correct-token')

    const decision = await decideWebhookAction(computeExpectedToken, null, 'unknown-channel', 'correct-token', 'exists')

    expect(decision).toEqual({ action: 'reject' })
    // 未知チャネルはトークン計算するまでもなく reject する
    expect(computeExpectedToken).not.toHaveBeenCalled()
  })

  it('rejects when channelId header is missing', async () => {
    const computeExpectedToken = vi.fn(async () => 'correct-token')
    const watch = makeWatch()

    const decision = await decideWebhookAction(computeExpectedToken, watch, null, 'correct-token', 'exists')

    expect(decision).toEqual({ action: 'reject' })
  })

  it('rejects when channelToken header is missing', async () => {
    const computeExpectedToken = vi.fn(async () => 'correct-token')
    const watch = makeWatch()

    const decision = await decideWebhookAction(computeExpectedToken, watch, 'channel-1', null, 'exists')

    expect(decision).toEqual({ action: 'reject' })
  })

  it('ignores the initial sync notification (X-Goog-Resource-State: sync) even with a valid token', async () => {
    const computeExpectedToken = vi.fn(async () => 'correct-token')
    const watch = makeWatch()

    const decision = await decideWebhookAction(computeExpectedToken, watch, 'channel-1', 'correct-token', 'sync')

    expect(decision).toEqual({ action: 'ignore_sync' })
  })
})
