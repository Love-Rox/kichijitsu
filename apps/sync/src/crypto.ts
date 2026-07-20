/**
 * refresh_token の at-rest 暗号化。AES-256-GCM、暗号化のたびにランダムな 12 バイト IV。
 *
 * 保存形式: `v1:<base64url(iv)>:<base64url(ciphertext)>`
 * 先頭のバージョンプレフィックスは、将来鍵のローテーション方式や暗号方式を変える際に
 * 新旧フォーマットを区別できるようにするためのもの。
 */

const FORMAT_VERSION = "v1";
const IV_BYTES = 12;

/** `v1:` プレフィックスが無い、または壊れた/改ざんされた/別鍵で書かれた値。 */
export class InvalidCiphertextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCiphertextError";
  }
}

// TOKEN_ENC_KEY (base64) ごとに import 済み CryptoKey をメモ化する。実運用では鍵は常に
// 1 種類だが、Map にしておくことでテストで複数の鍵を扱っても取り違えが起きない。
const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(base64Key: string): Promise<CryptoKey> {
  const cached = keyCache.get(base64Key);
  if (cached) return cached;

  const promise = (async () => {
    const raw = standardBase64ToBytes(base64Key);
    if (raw.length !== 32) {
      throw new Error(
        `TOKEN_ENC_KEY must decode to exactly 32 bytes for AES-256-GCM (got ${raw.length})`,
      );
    }
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  })();
  keyCache.set(base64Key, promise);
  return promise;
}

function standardBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function base64UrlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const binary = String.fromCharCode(...array);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return standardBase64ToBytes(base64);
}

export async function encryptToken(base64Key: string, plaintext: string): Promise<string> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${FORMAT_VERSION}:${base64UrlEncode(iv)}:${base64UrlEncode(ciphertext)}`;
}

/**
 * 復号する。`v1:` プレフィックスが無い値 (= 移行前の平文行、または壊れた値) は
 * 復号を試みず InvalidCiphertextError を投げる。呼び出し側はこれを「再連携が必要」
 * (401 相当) として扱うこと。
 */
export async function decryptToken(base64Key: string, stored: string): Promise<string> {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== FORMAT_VERSION) {
    throw new InvalidCiphertextError("refresh_token is not in the expected v1 ciphertext format");
  }
  const [, ivPart, ciphertextPart] = parts;

  const key = await importKey(base64Key);
  const iv = base64UrlDecode(ivPart);
  const ciphertext = base64UrlDecode(ciphertextPart);

  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    // GCM の認証タグ検証失敗 (改ざん、または別の鍵で暗号化されたもの) は DOMException。
    // 統一したエラー型に包んで呼び出し側の分岐を単純にする。
    throw new InvalidCiphertextError(
      "failed to decrypt refresh_token (tampered ciphertext or wrong key)",
    );
  }
}
