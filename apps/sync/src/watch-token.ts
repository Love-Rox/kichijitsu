/**
 * Google Calendar watch channel の X-Goog-Channel-Token 検証用ユーティリティ。
 *
 * Google の push 通知 (webhook) は誰でも POST /api/webhook/google を叩けてしまうため、
 * こちらが発行した正当な channel からの通知であることを確認する必要がある。
 * トークン自体は D1 に保存せず、`channelId` から HMAC-SHA256(SESSION_SECRET, channelId) を
 * 都度再計算して比較する (session cookie の署名と同じ鍵・同じ考え方)。
 *
 * 先頭16文字に切り詰めるのは Google 側の token 長制限 (256 バイト程度) には十分余裕があり、
 * base64url 16 文字 ≈ 96 bit のエントロピーがあれば総当たりは非現実的なため。
 */

const CHANNEL_TOKEN_LENGTH = 16;

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function base64UrlEncode(bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function computeChannelToken(secret: string, channelId: string): Promise<string> {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(channelId));
  return base64UrlEncode(signature).slice(0, CHANNEL_TOKEN_LENGTH);
}

/** タイミング攻撃を避けるための定数時間文字列比較 (session.ts と同じ考え方)。 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
