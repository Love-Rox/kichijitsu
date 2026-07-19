import { GoogleApiError } from '../core/errors'

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3/calendars'
const CHANNELS_STOP_URL = 'https://www.googleapis.com/calendar/v3/channels/stop'

export interface RegisterWatchParams {
  calendarId: string
  channelId: string
  /** webhook が届く先。 `${WEBHOOK_BASE_URL}/api/webhook/google` */
  address: string
  /** X-Goog-Channel-Token として送り返される値 (watch-token.ts で計算する)。 */
  token: string
}

export interface RegisteredWatch {
  resourceId: string
  /** Google はミリ秒 epoch を文字列で返す。無ければ null (安全側に倒し Cron 更新の対象外にする)。 */
  expiration: number | null
}

/**
 * Google Calendar `events.watch` を呼び、push 通知チャネルを登録する。
 * localhost 等の未検証ドメインへの address 指定は Google 側が拒否する (best-effort 呼び出し元で処理)。
 */
export async function registerWatch(
  fetchFn: typeof fetch,
  accessToken: string,
  params: RegisterWatchParams,
): Promise<RegisteredWatch> {
  const response = await fetchFn(`${CALENDAR_BASE}/${encodeURIComponent(params.calendarId)}/events/watch`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: params.channelId,
      type: 'web_hook',
      address: params.address,
      token: params.token,
    }),
  })
  if (!response.ok) {
    throw new GoogleApiError(response.status, await response.text())
  }
  const data = (await response.json()) as { resourceId: string; expiration?: string }
  return {
    resourceId: data.resourceId,
    expiration: data.expiration ? Number(data.expiration) : null,
  }
}

export interface StopWatchParams {
  channelId: string
  resourceId: string
}

/**
 * Google Calendar `channels.stop` を呼び、push 通知チャネルを解除する。
 * 呼び出し元 (連携解除・enabled=false・Cron 更新での旧チャネル破棄) は、成否に関わらず
 * ローカルの後続処理 (D1 行削除など) を続行してよい設計のため、ここでは throw しない。
 */
export async function stopWatch(fetchFn: typeof fetch, accessToken: string, params: StopWatchParams): Promise<boolean> {
  try {
    const response = await fetchFn(CHANNELS_STOP_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: params.channelId, resourceId: params.resourceId }),
    })
    return response.ok
  } catch {
    return false
  }
}

export function buildWebhookAddress(webhookBaseUrl: string): string {
  return `${webhookBaseUrl}/api/webhook/google`
}
