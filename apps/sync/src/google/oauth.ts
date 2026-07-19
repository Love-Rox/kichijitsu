const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'

/** 将来の書き戻し (milestone 期日変更など) に備え calendar フルスコープを要求する。 */
export const OAUTH_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar'].join(' ')

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
