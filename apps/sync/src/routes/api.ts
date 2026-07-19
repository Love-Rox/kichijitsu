import { Hono, type Context } from 'hono'
import { deleteCookie } from 'hono/cookie'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ApiError, MeResponse, SyncRequest } from '@kichijitsu/shared'
import type { AppEnv } from '../types'
import { populateUserId, requireAuth } from '../middleware'
import { SESSION_COOKIE_NAME } from '../session'
import { decryptToken, InvalidCiphertextError } from '../crypto'
import { revokeToken } from '../google/oauth'
import type { RpcResult } from '../rpc-result'

export const apiRoutes = new Hono<AppEnv>()

apiRoutes.use('*', populateUserId)

apiRoutes.get('/api/me', async (c) => {
  const userId = c.get('userId')
  if (!userId) {
    return c.json<MeResponse>({ connected: false })
  }
  const row = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?')
    .bind(userId)
    .first<{ email: string }>()
  if (!row) {
    return c.json<MeResponse>({ connected: false })
  }
  return c.json<MeResponse>({ connected: true, email: row.email })
})

apiRoutes.get('/api/calendars', requireAuth, async (c) => {
  const userId = c.get('userId')!
  const stub = c.env.USER_SYNC.getByName(userId)
  const result = await stub.listCalendars(userId)
  return respondFromRpcResult(c, result)
})

apiRoutes.post('/api/sync', requireAuth, async (c) => {
  const userId = c.get('userId')!
  let body: SyncRequest
  try {
    body = await c.req.json<SyncRequest>()
  } catch {
    return c.json<ApiError>({ error: 'invalid_json' }, 400)
  }
  if (!body?.calendarId) {
    return c.json<ApiError>({ error: 'missing_calendarId' }, 400)
  }

  const stub = c.env.USER_SYNC.getByName(userId)
  const result = await stub.sync(userId, body.calendarId)
  return respondFromRpcResult(c, result)
})

// 連携解除 (アカウント削除)。順序が重要: revoke → DO 状態クリア → D1 行削除 → cookie 削除。
// 行削除を先にやってしまうと、その後 refresh_token を読めず revoke できなくなる事故が
// 起きるため、必ず revoke を最初に行う。
apiRoutes.delete('/api/account', requireAuth, async (c) => {
  const userId = c.get('userId')!

  const row = await c.env.DB.prepare('SELECT refresh_token FROM users WHERE id = ?')
    .bind(userId)
    .first<{ refresh_token: string }>()

  if (row) {
    let refreshToken: string | null = null
    try {
      refreshToken = await decryptToken(c.env.TOKEN_ENC_KEY, row.refresh_token)
    } catch (err) {
      if (!(err instanceof InvalidCiphertextError)) throw err
      // 復号できない (旧平文行・改ざん等) トークンは revoke しようがない。「連携解除したい」
      // というユーザーの意図に対し、これは削除を妨げる理由にはならないのでスキップする。
      console.warn(`account deletion: refresh_token for user ${userId} could not be decrypted, skipping revoke`)
    }
    if (refreshToken) {
      const revoked = await revokeToken(fetch, refreshToken)
      if (!revoked) {
        console.warn(`account deletion: failed to revoke Google token for user ${userId}`)
      }
    }
  }

  const stub = c.env.USER_SYNC.getByName(userId)
  const clearResult = await stub.clearSyncState()
  if (!clearResult.ok) {
    console.warn(`account deletion: failed to clear DO sync state for user ${userId}: ${clearResult.error}`)
  }

  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run()

  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' })
  return c.body(null, 204)
})

function respondFromRpcResult<T>(c: Context<AppEnv>, result: RpcResult<T>) {
  if (result.ok) {
    return c.json(result.data)
  }
  // RpcResult.status は Google/内部エラーに由来する実 HTTP ステータス (401/403/404/410/429/5xx など)。
  // 1xx や 204/304 のような「本文なし」コードにはならない。
  return c.json<ApiError>({ error: result.error }, result.status as ContentfulStatusCode)
}
