/**
 * セッション cookie (`sid`) の発行・検証。
 * 形式: `userId.expiresAtEpochSeconds.signature` (署名対象は `userId.expiresAt`)。
 *
 * 旧形式 (`userId.signature` の 2 パート、期限なし) の cookie は、パース段階で
 * 3 パートに分解できず自然に検証失敗 (null) になる。これは意図的な挙動であり、
 * 移行処理は不要 — 単に未認証として扱われ、ユーザーは再ログインに誘導される。
 */

const SID_COOKIE = 'sid'
const STATE_COOKIE = 'oauth_state'
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30 // 30 days
const STATE_MAX_AGE_SECONDS = 60 * 10 // 10 minutes

export const SESSION_COOKIE_NAME = SID_COOKIE
export const STATE_COOKIE_NAME = STATE_COOKIE
export const SESSION_COOKIE_MAX_AGE = SESSION_MAX_AGE_SECONDS
export const STATE_COOKIE_MAX_AGE = STATE_MAX_AGE_SECONDS

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

function base64UrlEncode(bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sign(secret: string, data: string): Promise<string> {
  const key = await hmacKey(secret)
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return base64UrlEncode(signature)
}

/** タイミング攻撃を避けるための定数時間文字列比較。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * `userId.expiresAt.signature` の右側 2 セグメントを取り出す。
 * userId 自体にドットが含まれていても壊れないよう、右から分解する。
 * 旧形式 (2 パートしかない) はここで null になる。
 */
function splitSessionValue(value: string): { userId: string; expiresAtStr: string; signature: string } | null {
  const lastDot = value.lastIndexOf('.')
  if (lastDot === -1) return null
  const signature = value.slice(lastDot + 1)
  const rest = value.slice(0, lastDot)

  const secondDot = rest.lastIndexOf('.')
  if (secondDot === -1) return null
  const expiresAtStr = rest.slice(secondDot + 1)
  const userId = rest.slice(0, secondDot)

  if (!userId || !expiresAtStr || !signature) return null
  return { userId, expiresAtStr, signature }
}

export async function createSessionCookieValue(
  secret: string,
  userId: string,
  now: number = Date.now(),
): Promise<string> {
  const expiresAt = Math.floor(now / 1000) + SESSION_MAX_AGE_SECONDS
  const signature = await sign(secret, `${userId}.${expiresAt}`)
  return `${userId}.${expiresAt}.${signature}`
}

/** 署名が正しくかつ期限内なら userId を返す。不正・改ざん・期限切れ・旧形式は null。 */
export async function verifySessionCookieValue(
  secret: string,
  value: string,
  now: number = Date.now(),
): Promise<string | null> {
  const parsed = splitSessionValue(value)
  if (!parsed) return null
  const { userId, expiresAtStr, signature } = parsed

  const expiresAt = Number(expiresAtStr)
  if (!Number.isInteger(expiresAt)) return null

  const expected = await sign(secret, `${userId}.${expiresAtStr}`)
  if (!timingSafeEqual(expected, signature)) return null

  const nowSeconds = Math.floor(now / 1000)
  if (expiresAt <= nowSeconds) return null

  return userId
}
