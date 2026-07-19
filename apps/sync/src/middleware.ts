import { createMiddleware } from 'hono/factory'
import { getCookie } from 'hono/cookie'
import type { AppEnv } from './types'
import { SESSION_COOKIE_NAME, verifySessionCookieValue } from './session'

/** sid cookie を検証し、正当なら `userId` を context に積む。未認証でも先へ進める。 */
export const populateUserId = createMiddleware<AppEnv>(async (c, next) => {
  const sid = getCookie(c, SESSION_COOKIE_NAME)
  if (sid) {
    const userId = await verifySessionCookieValue(c.env.SESSION_SECRET, sid)
    if (userId) {
      c.set('userId', userId)
    }
  }
  await next()
})

/** `userId` が積まれていなければ 401 を返す。populateUserId の後段で使う。 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get('userId')) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
})
