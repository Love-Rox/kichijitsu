import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ApiError, MeResponse, SyncRequest } from '@hiyori/shared'
import type { AppEnv } from '../types'
import { populateUserId, requireAuth } from '../middleware'
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

function respondFromRpcResult<T>(c: Context<AppEnv>, result: RpcResult<T>) {
  if (result.ok) {
    return c.json(result.data)
  }
  // RpcResult.status は Google/内部エラーに由来する実 HTTP ステータス (401/403/404/410/429/5xx など)。
  // 1xx や 204/304 のような「本文なし」コードにはならない。
  return c.json<ApiError>({ error: result.error }, result.status as ContentfulStatusCode)
}
