import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AppEnv } from '../types'
import {
  STATE_COOKIE_MAX_AGE,
  STATE_COOKIE_NAME,
  SESSION_COOKIE_MAX_AGE,
  SESSION_COOKIE_NAME,
  createSessionCookieValue,
} from '../session'
import { buildAuthorizationUrl, decodeIdToken, exchangeCodeForTokens } from '../google/oauth'

export const authRoutes = new Hono<AppEnv>()

function redirectUriFor(requestUrl: string): string {
  return new URL('/auth/callback', requestUrl).toString()
}

authRoutes.get('/auth/login', (c) => {
  const state = crypto.randomUUID()

  // Secure 属性は localhost (http) でも主要ブラウザが「潜在的に信頼できるオリジン」として
  // 扱うため wrangler dev でも問題なく動く。
  setCookie(c, STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: STATE_COOKIE_MAX_AGE,
  })

  const authorizationUrl = buildAuthorizationUrl(
    {
      clientId: c.env.GOOGLE_CLIENT_ID,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      redirectUri: redirectUriFor(c.req.url),
    },
    state,
  )

  return c.redirect(authorizationUrl, 302)
})

authRoutes.get('/auth/callback', async (c) => {
  const code = c.req.query('code')
  const returnedState = c.req.query('state')
  const oauthError = c.req.query('error')
  const cookieState = getCookie(c, STATE_COOKIE_NAME)
  deleteCookie(c, STATE_COOKIE_NAME, { path: '/' })

  if (oauthError) {
    return c.json({ error: `google_oauth_error: ${oauthError}` }, 400)
  }
  if (!code || !returnedState || !cookieState || returnedState !== cookieState) {
    return c.json({ error: 'invalid_oauth_state' }, 400)
  }

  const tokens = await exchangeCodeForTokens(
    fetch,
    {
      clientId: c.env.GOOGLE_CLIENT_ID,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      redirectUri: redirectUriFor(c.req.url),
    },
    code,
  )
  if (!tokens.idToken) {
    return c.json({ error: 'missing_id_token' }, 502)
  }
  const { sub: userId, email } = decodeIdToken(tokens.idToken)

  // 再連携で Google が refresh_token を返さないことがある (通常は最初の同意時のみ発行)。
  // その場合は既存の refresh_token を保持する。
  const existing = await c.env.DB.prepare('SELECT refresh_token FROM users WHERE id = ?')
    .bind(userId)
    .first<{ refresh_token: string }>()
  const refreshToken = tokens.refreshToken ?? existing?.refresh_token
  if (!refreshToken) {
    return c.json({ error: 'missing_refresh_token' }, 502)
  }

  await c.env.DB.prepare(
    `INSERT INTO users (id, email, refresh_token, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, refresh_token = excluded.refresh_token`,
  )
    .bind(userId, email, refreshToken, Date.now())
    .run()

  const sessionValue = await createSessionCookieValue(c.env.SESSION_SECRET, userId)
  setCookie(c, SESSION_COOKIE_NAME, sessionValue, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE,
  })

  return c.redirect(c.env.APP_URL, 302)
})
