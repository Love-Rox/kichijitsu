import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AppEnv } from '../types'
import {
  STATE_COOKIE_MAX_AGE,
  STATE_COOKIE_NAME,
  SESSION_COOKIE_MAX_AGE,
  SESSION_COOKIE_NAME,
  createSessionCookieValue,
  verifySessionCookieValue,
} from '../session'
import { buildAuthorizationUrl, decodeIdToken, exchangeCodeForTokens, hasRequiredScopes } from '../google/oauth'
import { isHttpsRequest } from '../http'
import { isEmailAllowed } from '../allowlist'
import { encryptToken } from '../crypto'
import { encodeOAuthState, decodeOAuthState } from '../oauth-state'

export const authRoutes = new Hono<AppEnv>()

function redirectUriFor(env: { OAUTH_REDIRECT_URL?: string }, requestUrl: string): string {
  // 通常はリクエスト URL から導出する (本番では https://kichijitsu.love-rox.cc/auth/callback)。
  // ただし wrangler dev は wrangler.jsonc に routes があるとリクエスト URL を本番ルートの
  // ホスト (http://kichijitsu.love-rox.cc/...) でシミュレートするため、そのまま使うと
  // redirect_uri_mismatch になる。ローカルでは .dev.vars の OAUTH_REDIRECT_URL
  // (http://localhost:8787/auth/callback) で明示上書きする。空文字は未設定扱い。
  if (env.OAUTH_REDIRECT_URL) return env.OAUTH_REDIRECT_URL
  return new URL('/auth/callback', requestUrl).toString()
}

authRoutes.get('/auth/login', async (c) => {
  // ?add=1 は「今のセッション (プロファイル) にアカウントを追加する」モード。
  // 有効なセッションが無ければ通常ログインにフォールバックする (新規プロファイルを作る)。
  const wantsAddMode = c.req.query('add') === '1'
  let addModeProfileId: string | null = null
  if (wantsAddMode) {
    const sid = getCookie(c, SESSION_COOKIE_NAME)
    if (sid) {
      addModeProfileId = await verifySessionCookieValue(c.env.SESSION_SECRET, sid)
    }
  }

  const nonce = crypto.randomUUID()
  const state = encodeOAuthState(
    addModeProfileId ? { nonce, mode: 'add', profileId: addModeProfileId } : { nonce, mode: 'login' },
  )

  // 本番 (https://kichijitsu.love-rox.cc) では Secure を付け、ローカル `wrangler dev`
  // (素の http://localhost) では付けない。Secure な Cookie は非 HTTPS ではブラウザに
  // 保存されない実装もあるため、リクエストのスキームで動的に切り替える。
  setCookie(c, STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: isHttpsRequest(c.req.url),
    sameSite: 'Lax',
    path: '/',
    maxAge: STATE_COOKIE_MAX_AGE,
  })

  const authorizationUrl = buildAuthorizationUrl(
    {
      clientId: c.env.GOOGLE_CLIENT_ID,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      redirectUri: redirectUriFor(c.env, c.req.url),
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
  const state = decodeOAuthState(cookieState)
  if (!state) {
    return c.json({ error: 'invalid_oauth_state' }, 400)
  }

  const tokens = await exchangeCodeForTokens(
    fetch,
    {
      clientId: c.env.GOOGLE_CLIENT_ID,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      redirectUri: redirectUriFor(c.env, c.req.url),
    },
    code,
  )
  if (!tokens.idToken) {
    return c.json({ error: 'missing_id_token' }, 502)
  }

  if (!hasRequiredScopes(tokens.scope)) {
    // granular consent でユーザーがカレンダー系スコープの一部/全部を外した場合。
    // accountId/email 抜きで判定できるので decodeIdToken より前でチェックし、accounts への
    // 保存 (refresh_token を含む) は一切行わずに弾く。allowlist / scope 検査はアカウント
    // 単位で行う (login/add どちらのモードでも同じ)。
    const deniedUrl = new URL(c.env.APP_URL)
    deniedUrl.searchParams.set('auth_error', 'insufficient_scope')
    return c.redirect(deniedUrl.toString(), 302)
  }

  const { sub: accountId, email } = decodeIdToken(tokens.idToken)

  if (!isEmailAllowed(c.env.ALLOWED_EMAILS, email)) {
    // 招待制 allowlist に無いメールアドレス。accounts への保存 (特に refresh_token) を
    // 一切行わずに弾く — 未招待ユーザーの Google トークンをサーバーに残さないため。
    const deniedUrl = new URL(c.env.APP_URL)
    deniedUrl.searchParams.set('auth_error', 'not_invited')
    return c.redirect(deniedUrl.toString(), 302)
  }

  // 再連携で Google が refresh_token を返さないことがある (通常は最初の同意時のみ発行)。
  // その場合は既存の (暗号化済み) refresh_token をそのまま再利用する。
  const existing = await c.env.DB.prepare('SELECT profile_id, refresh_token FROM accounts WHERE id = ?')
    .bind(accountId)
    .first<{ profile_id: string; refresh_token: string }>()

  // プロファイルの決め方:
  // - add モード: state に載っている (今ログイン中の) プロファイルにそのまま追加する。
  //   既にこの Google アカウントが別プロファイルに属していても、今回の OAuth 同意で
  //   本人確認は取れているので、現在のプロファイルへ付け替える (アカウントの持ち主が
  //   自分の意思で行う操作なので、これは正当な移動として扱う)。
  // - login モード (通常): このアカウントが既にどこかのプロファイルに属していれば
  //   それを使う (= 再ログイン)。初めて連携するアカウントなら新しいプロファイルを作る。
  const profileId = state.mode === 'add' ? state.profileId : (existing?.profile_id ?? crypto.randomUUID())

  // Google から新しい平文 refresh_token を受け取った時だけ暗号化する。既存行を使い回す
  // 場合は D1 に入っている値 (= 既に v1 暗号文、または移行対象外の旧平文) をそのまま書き戻す
  // だけなので、ここで復号する必要はない。
  const refreshTokenToStore = tokens.refreshToken
    ? await encryptToken(c.env.TOKEN_ENC_KEY, tokens.refreshToken)
    : existing?.refresh_token
  if (!refreshTokenToStore) {
    return c.json({ error: 'missing_refresh_token' }, 502)
  }

  await c.env.DB.prepare(
    `INSERT INTO accounts (id, profile_id, email, refresh_token, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, email = excluded.email, refresh_token = excluded.refresh_token`,
  )
    .bind(accountId, profileId, email, refreshTokenToStore, Date.now())
    .run()

  if (state.mode !== 'add') {
    // add モードでは既存セッションをそのまま使うので、新しい sid は発行しない
    // (「新セッションを作らない」)。
    const sessionValue = await createSessionCookieValue(c.env.SESSION_SECRET, profileId)
    setCookie(c, SESSION_COOKIE_NAME, sessionValue, {
      httpOnly: true,
      secure: isHttpsRequest(c.req.url),
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_COOKIE_MAX_AGE,
    })
  }

  return c.redirect(c.env.APP_URL, 302)
})

// 認証不要 (sid が無くても/無効でも成功扱い): ログアウトは「もう sid を持っていない状態」が
// ゴールなので、既に未認証でも 204 を返してよい。
//
// CSRF: POST + SameSite=Lax の組み合わせで十分。SameSite=Lax は cross-site の POST では
// Cookie を送らない (許可されるのはトップレベル navigation の GET のみ) ため、他サイトの
// フォーム/fetch からこのエンドポイントを叩いても sid が付与されず、ログアウトはできても
// 「他人を強制ログアウトさせる」以上の実害 (なりすまし等) が起きない。GET にしないのは
// ブラウザのプリフェッチや <img src> のような偶発的な GET でログアウトが誘発されるのを防ぐため。
authRoutes.post('/auth/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' })
  return c.body(null, 204)
})
