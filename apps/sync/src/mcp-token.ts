/**
 * kichijitsu 発行の MCP トークン (docs/mcp.md) のフォーマット・生成・ハッシュ化ユーティリティ。
 *
 * トークンは `mcp_` プレフィックス + 32 バイトのランダム値を base64url (パディング無し) した
 * 文字列 (例: `mcp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`、通常は合計47文字)。
 * 生値はクライアント (Claude 等の MCP クライアント) 側にのみ保持され、サーバーは
 * SHA-256 ハッシュ (hex) だけを DB (mcp_tokens.token_hash) に保存する — refresh_token 等と違い
 * 「元に戻す」必要が無い (照合できれば十分な) ため、crypto.ts の AES-GCM 可逆暗号化ではなく
 * 一方向ハッシュを使う。ハッシュを平文で保存しても、そこから生値を復元することはできない。
 */

const RAW_TOKEN_BYTES = 32;
const TOKEN_PREFIX = "mcp_";

// generateMcpToken は常に TOKEN_PREFIX (4文字) + base64url(32 bytes, パディング無し) = 43文字、
// 合計47文字を生成する。ここでは「生成物より明確に短い」ラインとして
// TOKEN_PREFIX + 30文字 (合計34文字) を最小長とする — 総当たりや切り詰められた値を
// 安価に (D1/ハッシュ計算に触れる前に) 弾くための緩いフォーマットチェックであり、
// 正確な長さを強制するものではない (将来トークン長を変えても壊れないように)。
const MIN_TOKEN_LENGTH = TOKEN_PREFIX.length + 30;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 新しい生トークンを生成する。DB への保存等の副作用は一切持たない純粋な生成のみ。 */
export function generateMcpToken(): { raw: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(RAW_TOKEN_BYTES));
  return { raw: `${TOKEN_PREFIX}${base64UrlEncode(bytes)}` };
}

/** 生トークンの UTF-8 バイト列を SHA-256 ハッシュし、小文字 hex で返す (DB 保存形式)。 */
export async function hashMcpToken(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return bytesToHex(new Uint8Array(digest));
}

/**
 * D1 やハッシュ計算に触れる前の安価なフォーマット検証。`mcp_` プレフィックスと
 * 最低限の長さだけを見る (中身のエントロピーまでは検証しない)。
 */
export function isValidMcpTokenFormat(raw: string): boolean {
  return raw.startsWith(TOKEN_PREFIX) && raw.length >= MIN_TOKEN_LENGTH;
}
