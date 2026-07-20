const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'

const FULL_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar'
const EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events'
const CALENDARLIST_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'
// Google タスク連携 (docs/google-tasks.md、2026-07-20)。sensitive スコープなので
// 「使っていないスコープは要求しない」審査ポリシー上、タスク機能の実装が入った今回の
// リリースから要求を開始する。
const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks'

// Google OAuth 審査を通しやすくするため、書き込み権限を含むフル `calendar` スコープではなく
// 予定の読み書き (calendar.events) とカレンダー一覧の読み取り (calendarlist.readonly) だけを
// 要求する (最小権限)。tasks はオプション機能 (無くてもカレンダーは動く) なので
// hasRequiredScopes には含めない — 個別に hasTasksScope で判定する。
export const OAUTH_SCOPES = ['openid', 'email', EVENTS_SCOPE, CALENDARLIST_READONLY_SCOPE, TASKS_SCOPE].join(' ')

/**
 * granular consent (Google がスコープを個別に同意/拒否させる機能) では、要求した
 * スコープの一部だけが許可されて token レスポンスが返ってくることがある。
 *
 * calendarlist.readonly が無くても「primary カレンダー固定」で動く余地はあるが、
 * 現状の実装 (GET /api/calendars は calendarList.list を呼ぶ) はこれが無いと
 * 機能しないため、緩和せず calendar.events と同様に必須として扱う。将来 primary への
 * フォールバックを実装したら、この判定を緩めてよい。
 *
 * 旧フルスコープ (`.../auth/calendar`) は新しい 2 スコープの上位互換 (読み書き権限を
 * 包含する) なので、granted に旧スコープしか無くても要件を満たしたものとして扱う —
 * これにより、旧フルスコープで既に連携済みのユーザーが再連携しても弾かれない。
 */
export function hasRequiredScopes(grantedScope: string | undefined): boolean {
  const granted = new Set((grantedScope ?? '').split(' ').filter(Boolean))
  const hasEvents = granted.has(EVENTS_SCOPE) || granted.has(FULL_CALENDAR_SCOPE)
  const hasCalendarList = granted.has(CALENDARLIST_READONLY_SCOPE) || granted.has(FULL_CALENDAR_SCOPE)
  return hasEvents && hasCalendarList
}

/**
 * tasks はオプション機能なので hasRequiredScopes とは独立に判定する。granted は
 * OAuth トークン交換時点の scope 文字列 (ExchangedTokens.scope) を想定しているが、
 * これは現状 D1 に永続化していない (accounts テーブルに scope 列が無い) ため、
 * 最小実装では実際の判定は「Google Tasks API を叩いて 403 が返るか」で行う
 * (routes/api.ts の GET /api/tasklists 参照)。この関数はその判定ロジックを純関数として
 * テストできるようにするため、また将来 /api/me 等でスコープの有無をクライアントへ
 * 返す (accounts テーブルに scope を保存する) ようになった時にそのまま使えるように
 * 用意してある。
 *
 * 既存ユーザー (tasks 追加前に連携済み) はこの関数が false を返す状態のままであり、
 * タスク機能を使うには再連携 (OAuth 同意のやり直し) が必要 — 新しい OAUTH_SCOPES で
 * 再度 /auth/login を通すことで tasks 権限も得られる。
 */
export function hasTasksScope(grantedScope: string | undefined): boolean {
  const granted = new Set((grantedScope ?? '').split(' ').filter(Boolean))
  return granted.has(TASKS_SCOPE)
}

export interface GoogleOAuthConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export function buildAuthorizationUrl(config: GoogleOAuthConfig, state: string): string {
  const url = new URL(AUTH_ENDPOINT)
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', OAUTH_SCOPES)
  // refresh_token を確実に受け取るための組み合わせ (offline + 毎回同意を強制)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', state)
  return url.toString()
}

interface TokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  id_token?: string
  scope: string
  token_type: string
}

export interface ExchangedTokens {
  accessToken: string
  expiresIn: number
  refreshToken?: string
  idToken?: string
  /** granular consent で実際に許可されたスコープ (space 区切り)。hasRequiredScopes に渡す。 */
  scope: string
}

export async function exchangeCodeForTokens(
  fetchFn: typeof fetch,
  config: GoogleOAuthConfig,
  code: string,
): Promise<ExchangedTokens> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: config.redirectUri,
  })
  const response = await fetchFn(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!response.ok) {
    throw new Error(`Google token exchange failed: HTTP ${response.status}: ${await response.text()}`)
  }
  const data = (await response.json()) as TokenResponse
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    refreshToken: data.refresh_token,
    idToken: data.id_token,
    scope: data.scope,
  }
}

export interface RefreshedTokens {
  accessToken: string
  expiresIn: number
}

export async function refreshAccessToken(
  fetchFn: typeof fetch,
  config: Pick<GoogleOAuthConfig, 'clientId' | 'clientSecret'>,
  refreshToken: string,
): Promise<RefreshedTokens> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  const response = await fetchFn(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!response.ok) {
    throw new Error(`Google token refresh failed: HTTP ${response.status}: ${await response.text()}`)
  }
  const data = (await response.json()) as TokenResponse
  return { accessToken: data.access_token, expiresIn: data.expires_in }
}

export interface IdTokenPayload {
  sub: string
  email: string
}

/**
 * id_token の payload を検証なしでデコードするだけ。署名検証を省略できるのは、
 * この id_token を「トークンエンドポイントへの直接 POST の応答」として受け取って
 * いるため (third-party から渡された id_token を信用するケースとは異なり、
 * 経路は TLS で守られた Google 対 このサーバーの通信のみ)。
 */
export function decodeIdToken(idToken: string): IdTokenPayload {
  const parts = idToken.split('.')
  if (parts.length !== 3) {
    throw new Error('Malformed id_token')
  }
  const payload = JSON.parse(base64UrlDecode(parts[1])) as { sub?: string; email?: string }
  if (!payload.sub || !payload.email) {
    throw new Error('id_token payload missing sub/email')
  }
  return { sub: payload.sub, email: payload.email }
}

function base64UrlDecode(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=')
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/**
 * アカウント削除 (連携解除) 時に Google 側のトークンを失効させる。
 *
 * 呼び出し側は revoke の成否に関わらず削除処理 (D1 行削除等) を続行してよい設計のため、
 * ここでは決して throw しない (ネットワークエラーも含めて false を返すだけ)。
 * 既に失効済みのトークンに対する revoke は Google 側が 400 を返すことがあるが、
 * それは「連携解除したい」というユーザーの意図の達成を妨げる理由にはならない。
 */
export async function revokeToken(fetchFn: typeof fetch, token: string): Promise<boolean> {
  try {
    const response = await fetchFn(REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    })
    return response.ok
  } catch {
    return false
  }
}
