import { Hono, type Context } from 'hono'
import { deleteCookie } from 'hono/cookie'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AccountDTO, ApiError, DisconnectRequest, MeResponse, SyncRequest, WatchRequest } from '@kichijitsu/shared'
import type { AppEnv } from '../types'
import { populateProfileId, requireAuth } from '../middleware'
import { SESSION_COOKIE_NAME } from '../session'
import { decryptToken, InvalidCiphertextError } from '../crypto'
import { revokeToken } from '../google/oauth'
import { registerWatch, stopWatch, buildWebhookAddress } from '../google/watch'
import { isAccountInProfile, resolveDisconnectTargets, shouldClearSessionAfterDisconnect } from '../accounts'
import { buildWatchRow } from '../core/watch-service'
import { computeChannelToken } from '../watch-token'
import { PROFILE_ID_HEADER } from '../durable-object/profile-hub-do'
import type { RpcResult } from '../rpc-result'

export const apiRoutes = new Hono<AppEnv>()

interface WatchApiResponse {
  watching: boolean
}

apiRoutes.use('*', populateProfileId)

apiRoutes.get('/api/me', async (c) => {
  const profileId = c.get('profileId')
  if (!profileId) {
    return c.json<MeResponse>({ connected: false, accounts: [] })
  }
  const { results } = await c.env.DB.prepare('SELECT id, email FROM accounts WHERE profile_id = ? ORDER BY created_at ASC')
    .bind(profileId)
    .all<{ id: string; email: string }>()
  const accounts: AccountDTO[] = results.map((row) => ({ id: row.id, email: row.email }))
  return c.json<MeResponse>({ connected: accounts.length > 0, accounts })
})

apiRoutes.get('/api/calendars', requireAuth, async (c) => {
  const profileId = c.get('profileId')!
  const accountId = c.req.query('accountId')
  if (!accountId) {
    return c.json<ApiError>({ error: 'missing_accountId' }, 400)
  }

  const account = await c.env.DB.prepare('SELECT profile_id FROM accounts WHERE id = ?')
    .bind(accountId)
    .first<{ profile_id: string }>()
  if (!isAccountInProfile(account, profileId)) {
    // 存在しない accountId と「他人のプロファイルの accountId」を区別せず 403 にする
    // (存在有無を漏らさないため)。
    return c.json<ApiError>({ error: 'account_not_found' }, 403)
  }

  const stub = c.env.USER_SYNC.getByName(accountId)
  const result = await stub.listCalendars(accountId)
  return respondFromRpcResult(c, result)
})

apiRoutes.post('/api/sync', requireAuth, async (c) => {
  const profileId = c.get('profileId')!
  let body: SyncRequest
  try {
    body = await c.req.json<SyncRequest>()
  } catch {
    return c.json<ApiError>({ error: 'invalid_json' }, 400)
  }
  if (!body?.accountId || !body?.calendarId) {
    return c.json<ApiError>({ error: 'missing_accountId_or_calendarId' }, 400)
  }

  const account = await c.env.DB.prepare('SELECT profile_id FROM accounts WHERE id = ?')
    .bind(body.accountId)
    .first<{ profile_id: string }>()
  if (!isAccountInProfile(account, profileId)) {
    return c.json<ApiError>({ error: 'account_not_found' }, 403)
  }

  const stub = c.env.USER_SYNC.getByName(body.accountId)
  const result = await stub.sync(body.accountId, body.calendarId)
  return respondFromRpcResult(c, result)
})

// リアルタイム反映用の SSE ストリーム。通知はトリガーに過ぎず、データそのものは運ばない
// (クライアントは 'changed' を受けたら該当 accountId/calendarId を /api/sync で取りに行く)。
// ProfileHubDO 自身は自分の名前 (profileId) を知らないので、転送時にヘッダで明示的に渡す。
apiRoutes.get('/api/events', requireAuth, async (c) => {
  const profileId = c.get('profileId')!
  const stub = c.env.PROFILE_HUB.getByName(profileId)
  const headers = new Headers(c.req.raw.headers)
  headers.set(PROFILE_ID_HEADER, profileId)
  const forwarded = new Request(c.req.raw, { headers })
  return stub.fetch(forwarded)
})

// 選択中カレンダーの push 通知 (watch channel) 登録/解除。best-effort: 登録に失敗しても
// (ローカル開発の localhost address 拒否など) 200 で `{ watching: false }` を返す
// (ポーリングフォールバックが補うので、クライアントにエラー扱いさせる必要が無い)。
apiRoutes.post('/api/watch', requireAuth, async (c) => {
  const profileId = c.get('profileId')!
  let body: WatchRequest
  try {
    body = await c.req.json<WatchRequest>()
  } catch {
    return c.json<ApiError>({ error: 'invalid_json' }, 400)
  }
  if (!body?.accountId || !body?.calendarId || typeof body.enabled !== 'boolean') {
    return c.json<ApiError>({ error: 'missing_fields' }, 400)
  }

  const account = await c.env.DB.prepare('SELECT profile_id FROM accounts WHERE id = ?')
    .bind(body.accountId)
    .first<{ profile_id: string }>()
  if (!isAccountInProfile(account, profileId)) {
    return c.json<ApiError>({ error: 'account_not_found' }, 403)
  }

  if (!body.enabled) {
    await disableWatch(c.env, body.accountId, body.calendarId)
    return c.json<WatchApiResponse>({ watching: false })
  }

  const watching = await enableWatch(c.env, body.accountId, body.calendarId, profileId)
  return c.json<WatchApiResponse>({ watching })
})

// 連携解除 (アカウント削除)。accountId 指定ならそのアカウントだけ、省略ならプロファイル内
// 全アカウントを対象にする。対象ごとに: revoke → DO 状態クリア → D1 行削除、の順で実行
// (行削除を先にやると、その後 refresh_token を読めず revoke できなくなる事故が起きるため、
// 必ず revoke を最初に行う)。最後にプロファイルのアカウントが 0 件になった時だけ
// セッション (sid cookie) も破棄する。
apiRoutes.delete('/api/account', requireAuth, async (c) => {
  const profileId = c.get('profileId')!

  let body: DisconnectRequest = {}
  const rawBody = await c.req.text()
  if (rawBody) {
    try {
      body = JSON.parse(rawBody) as DisconnectRequest
    } catch {
      return c.json<ApiError>({ error: 'invalid_json' }, 400)
    }
  }

  const { results: profileAccounts } = await c.env.DB.prepare('SELECT id FROM accounts WHERE profile_id = ?')
    .bind(profileId)
    .all<{ id: string }>()
  const profileAccountIds = profileAccounts.map((row) => row.id)

  const targets = resolveDisconnectTargets(body, profileAccountIds)
  if (targets === null) {
    // body.accountId が指定されたが、このプロファイルには属していない (他人のアカウント等)。
    return c.json<ApiError>({ error: 'account_not_found' }, 403)
  }

  for (const accountId of targets) {
    await disconnectAccount(c.env, accountId)
  }

  const remaining = profileAccountIds.length - targets.length
  if (shouldClearSessionAfterDisconnect(remaining)) {
    deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' })
  }

  return c.body(null, 204)
})

/** 1 アカウント分の revoke → DO 状態クリア → D1 行削除。 */
async function disconnectAccount(env: Env, accountId: string): Promise<void> {
  const row = await env.DB.prepare('SELECT refresh_token FROM accounts WHERE id = ?')
    .bind(accountId)
    .first<{ refresh_token: string }>()

  if (row) {
    let refreshToken: string | null = null
    try {
      refreshToken = await decryptToken(env.TOKEN_ENC_KEY, row.refresh_token)
    } catch (err) {
      if (!(err instanceof InvalidCiphertextError)) throw err
      // 復号できない (旧平文行・改ざん等) トークンは revoke しようがない。「連携解除したい」
      // というユーザーの意図に対し、これは削除を妨げる理由にはならないのでスキップする。
      console.warn(`account deletion: refresh_token for account ${accountId} could not be decrypted, skipping revoke`)
    }
    if (refreshToken) {
      const revoked = await revokeToken(fetch, refreshToken)
      if (!revoked) {
        console.warn(`account deletion: failed to revoke Google token for account ${accountId}`)
      }
    }
  }

  const stub = env.USER_SYNC.getByName(accountId)
  const clearResult = await stub.clearSyncState()
  if (!clearResult.ok) {
    console.warn(`account deletion: failed to clear DO sync state for account ${accountId}: ${clearResult.error}`)
  }

  await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(accountId).run()
}

/**
 * watch 登録の本体。既存 watch があれば Google を呼ばずに何もしない (true を返す)。
 * それ以外の失敗 (アクセストークン取得不可・Google API エラー・localhost 拒否など) は
 * すべて best-effort として飲み込み false を返す — 呼び出し元はこれを 200 として返す。
 */
async function enableWatch(env: Env, accountId: string, calendarId: string, profileId: string): Promise<boolean> {
  const existing = await env.DB.prepare('SELECT 1 FROM watches WHERE account_id = ? AND calendar_id = ?')
    .bind(accountId, calendarId)
    .first()
  if (existing) {
    return true
  }

  try {
    const stub = env.USER_SYNC.getByName(accountId)
    const tokenResult = await stub.getValidAccessToken(accountId)
    if (!tokenResult.ok) {
      console.warn(`watch registration: could not get access token for account ${accountId}: ${tokenResult.error}`)
      return false
    }

    const channelId = crypto.randomUUID()
    const channelToken = await computeChannelToken(env.SESSION_SECRET, channelId)
    const registered = await registerWatch(fetch, tokenResult.data, {
      calendarId,
      channelId,
      address: buildWebhookAddress(env.WEBHOOK_BASE_URL),
      token: channelToken,
    })

    const row = buildWatchRow({ accountId, calendarId }, profileId, channelId, registered, Date.now())
    await env.DB.prepare(
      `INSERT INTO watches (channel_id, resource_id, account_id, calendar_id, profile_id, expiration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(row.channel_id, row.resource_id, row.account_id, row.calendar_id, row.profile_id, row.expiration_ms, row.created_at)
      .run()

    return true
  } catch (err) {
    console.warn(`watch registration failed (best-effort) for account=${accountId} calendar=${calendarId}`, err)
    return false
  }
}

/** watch 解除。既に watch が無ければ何もしない。Google 側の停止に失敗してもローカルの行は削除する
 * (「監視を止めたい」というクライアントの意図を妨げる理由にはならない — revokeToken と同じ考え方)。 */
async function disableWatch(env: Env, accountId: string, calendarId: string): Promise<void> {
  const row = await env.DB.prepare('SELECT channel_id, resource_id FROM watches WHERE account_id = ? AND calendar_id = ?')
    .bind(accountId, calendarId)
    .first<{ channel_id: string; resource_id: string | null }>()
  if (!row) return

  if (row.resource_id) {
    try {
      const stub = env.USER_SYNC.getByName(accountId)
      const tokenResult = await stub.getValidAccessToken(accountId)
      if (tokenResult.ok) {
        await stopWatch(fetch, tokenResult.data, { channelId: row.channel_id, resourceId: row.resource_id })
      }
    } catch (err) {
      console.warn(`watch stop failed (continuing to delete local row) for account=${accountId} calendar=${calendarId}`, err)
    }
  }

  await env.DB.prepare('DELETE FROM watches WHERE channel_id = ?').bind(row.channel_id).run()
}

function respondFromRpcResult<T>(c: Context<AppEnv>, result: RpcResult<T>) {
  if (result.ok) {
    return c.json(result.data)
  }
  // RpcResult.status は Google/内部エラーに由来する実 HTTP ステータス (401/403/404/410/429/5xx など)。
  // 1xx や 204/304 のような「本文なし」コードにはならない。
  return c.json<ApiError>({ error: result.error }, result.status as ContentfulStatusCode)
}
