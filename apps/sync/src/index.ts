import { Hono } from 'hono'
import type { AppEnv } from './types'
import { authRoutes } from './routes/auth'
import { apiRoutes } from './routes/api'

export { UserSyncDO } from './durable-object/user-sync-do'

const app = new Hono<AppEnv>()

app.route('/', authRoutes)
app.route('/', apiRoutes)

app.onError((err, c) => {
  console.error('Unhandled error', err)
  return c.json({ error: 'internal_error' }, 500)
})

export default app
