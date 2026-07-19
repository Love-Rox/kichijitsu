/** セッション cookie (`sid`) の発行・検証。sid の形式は `userId.signature`。 */

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

async function signUserId(secret: string, userId: string): Promise<string> {
  const key = await hmacKey(secret)
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(userId))
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

export async function createSessionCookieValue(secret: string, userId: string): Promise<string> {
  const signature = await signUserId(secret, userId)
  return `${userId}.${signature}`
}

/** 署名が正しければ userId を返す。不正・未署名なら null。 */
export async function verifySessionCookieValue(secret: string, value: string): Promise<string | null> {
  const separatorIndex = value.lastIndexOf('.')
  if (separatorIndex === -1) return null
  const userId = value.slice(0, separatorIndex)
  const signature = value.slice(separatorIndex + 1)
  if (!userId || !signature) return null
  const expected = await signUserId(secret, userId)
  return timingSafeEqual(expected, signature) ? userId : null
}
