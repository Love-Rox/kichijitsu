import { DurableObject } from 'cloudflare:workers'
import type { ServerEvent } from '@kichijitsu/shared'
import { SseRingBuffer } from '../core/sse-ring-buffer'

/**
 * GET /api/events (Worker 側ルート) が `stub.fetch(request)` で転送する際、DO 自身は
 * 自分の名前 (= profileId) を知らないので明示的にヘッダで渡す
 * ("DOs don't know their own ID" — explicit init と同じ考え方)。
 */
export const PROFILE_ID_HEADER = 'X-Kichijitsu-Profile-Id'

const KEEP_ALIVE_INTERVAL_MS = 20_000

interface Session {
  writer: WritableStreamDefaultWriter<Uint8Array>
  closed: boolean
}

function sseEvent(data: string, id?: number): Uint8Array {
  const idLine = id !== undefined ? `id: ${id}\n` : ''
  return new TextEncoder().encode(`${idLine}data: ${data}\n\n`)
}

function sseComment(text: string): Uint8Array {
  return new TextEncoder().encode(`: ${text}\n\n`)
}

function parseLastEventId(header: string | null): number | null {
  if (!header) return null
  const n = Number(header)
  return Number.isInteger(n) ? n : null
}

/**
 * プロファイル (= セッション) 単位の SSE ハブ。`env.PROFILE_HUB.getByName(profileId)` で
 * 常に同じインスタンスに到達する。
 *
 * 責務:
 * - GET /api/events からの SSE 接続を保持し、`notifyChanged` で受けた通知を配信する
 * - SSE 接続数が 0→1 / 1→0 になるタイミングで、このプロファイルに属する全アカウントの
 *   UserSyncDO へポーリングフォールバックの有効/無効を伝える
 *
 * **課金注意**: SSE 接続が張られている間、この DO は「active」としてウォールクロック
 * 時間分課金される (Durable Objects は「レスポンスストリームを保持している間は active」
 * という課金ルールのため)。個人〜招待制程度の同時接続数であれば許容できる前提で、
 * 接続時間に応じたコストの最適化 (例: 長時間アイドルなら能動的に切る等) はしていない。
 */
export class ProfileHubDO extends DurableObject<Env> {
  private readonly sessions = new Map<string, Session>()
  private readonly ringBuffer = new SseRingBuffer()
  private profileId: string | undefined

  async fetch(request: Request): Promise<Response> {
    const profileId = request.headers.get(PROFILE_ID_HEADER)
    if (!profileId) {
      return new Response('missing profile id', { status: 400 })
    }
    this.profileId = profileId

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    const sessionId = crypto.randomUUID()
    const session: Session = { writer, closed: false }

    const wasEmpty = this.sessions.size === 0
    this.sessions.set(sessionId, session)
    if (wasEmpty) {
      // 接続確立を遅らせないよう、ポーリング配線はバックグラウンドで行う。
      this.ctx.waitUntil(
        this.setPollingForProfile(profileId, true).catch((err) =>
          console.error(`ProfileHubDO: failed to start polling fallback for profile ${profileId}`, err),
        ),
      )
    }

    request.signal.addEventListener('abort', () => this.closeSession(sessionId))

    const lastEventId = parseLastEventId(request.headers.get('Last-Event-ID'))
    this.runSession(session, lastEventId).catch((err) => {
      console.error('ProfileHubDO: SSE session loop failed', err)
      this.closeSession(sessionId)
    })

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // nginx 等のプロキシがバッファリングで詰まらせないように
      },
    })
  }

  /**
   * webhook / ポーリングフォールバックから呼ばれる RPC。接続中の全 SSE へ配信する。
   * `notifyChanged` はトリガーに過ぎない — ペイロードにイベント本体は含めない。
   */
  async notifyChanged(accountId: string, calendarId: string): Promise<void> {
    const event: ServerEvent = { type: 'changed', accountId, calendarId }
    const buffered = this.ringBuffer.push(event)
    const payload = sseEvent(JSON.stringify(event), buffered.id)

    for (const [sessionId, session] of this.sessions) {
      try {
        await session.writer.write(payload)
      } catch {
        this.closeSession(sessionId)
      }
    }
  }

  private async runSession(session: Session, lastEventId: number | null): Promise<void> {
    // hello = 接続 (再接続) 時は取りこぼしがあり得るので、クライアントは hello 受信時に
    // 選択中カレンダーを一巡 sync する仕様 (README/protocol.ts のコメント参照)。
    await session.writer.write(sseEvent(JSON.stringify({ type: 'hello' } satisfies ServerEvent)))

    if (lastEventId !== null) {
      for (const buffered of this.ringBuffer.since(lastEventId)) {
        await session.writer.write(sseEvent(JSON.stringify(buffered.event), buffered.id))
      }
    }

    while (!session.closed) {
      await scheduler.wait(KEEP_ALIVE_INTERVAL_MS)
      if (session.closed) break
      await session.writer.write(sseComment('keep-alive'))
    }
  }

  private closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.closed = true
    this.sessions.delete(sessionId)
    session.writer.close().catch(() => {})

    if (this.sessions.size === 0 && this.profileId) {
      const profileId = this.profileId
      this.ctx.waitUntil(
        this.setPollingForProfile(profileId, false).catch((err) =>
          console.error(`ProfileHubDO: failed to stop polling fallback for profile ${profileId}`, err),
        ),
      )
    }
  }

  /**
   * このプロファイルに属する全アカウントの UserSyncDO へポーリングフォールバックの
   * 有効/無効を伝える。D1 で profile のアカウントを引いて各 DO の RPC を呼ぶだけの
   * シンプルな実装 (アカウント数は個人利用〜招待制規模なので並列呼び出しで十分)。
   */
  private async setPollingForProfile(profileId: string, enabled: boolean): Promise<void> {
    const { results } = await this.env.DB.prepare('SELECT id FROM accounts WHERE profile_id = ?')
      .bind(profileId)
      .all<{ id: string }>()

    await Promise.all(
      results.map((row) => {
        const stub = this.env.USER_SYNC.getByName(row.id)
        return enabled ? stub.enablePolling(row.id, profileId) : stub.disablePolling()
      }),
    )
  }
}
