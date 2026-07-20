import { describe, expect, it } from "vite-plus/test";
import { decryptToken, encryptToken, InvalidCiphertextError } from "../src/crypto";

const KEY_A = "CrHsQtGu/PWgNHz5b7oudGE0Ib889ulb4rs/Vw4jd48=";
const KEY_B = "ZmFrZS1rZXktZm9yLXRlc3RpbmctMzItYnl0ZXMhISE=";

describe("encryptToken / decryptToken", () => {
  it("round-trips plaintext through encrypt then decrypt with the same key", async () => {
    const plaintext = "1//0gExampleRefreshTokenValue";
    const stored = await encryptToken(KEY_A, plaintext);

    expect(stored.startsWith("v1:")).toBe(true);
    expect(stored.split(":")).toHaveLength(3);

    const decrypted = await decryptToken(KEY_A, stored);
    expect(decrypted).toBe(plaintext);
  });

  it("produces a different ciphertext (random IV) on every call", async () => {
    const plaintext = "same-plaintext";
    const a = await encryptToken(KEY_A, plaintext);
    const b = await encryptToken(KEY_A, plaintext);
    expect(a).not.toBe(b);
  });

  it("fails to decrypt with a different key", async () => {
    const stored = await encryptToken(KEY_A, "secret-value");
    await expect(decryptToken(KEY_B, stored)).rejects.toThrow(InvalidCiphertextError);
  });

  it("fails to decrypt when the ciphertext has been tampered with", async () => {
    const stored = await encryptToken(KEY_A, "secret-value");
    const [version, iv, ciphertext] = stored.split(":");
    // 先頭の1文字を変えて改ざんをシミュレートする (GCM の認証タグ検証で弾かれるはず)。
    // 末尾の base64 文字は padding ビットしか持たないことがあり、そこを変えても実際の
    // バイト列が変わらない場合があるため、確実に実データに当たる先頭側を変える。
    const firstChar = ciphertext.at(0);
    const flipped = firstChar === "a" ? "b" : "a";
    const tampered = `${version}:${iv}:${flipped}${ciphertext.slice(1)}`;

    await expect(decryptToken(KEY_A, tampered)).rejects.toThrow(InvalidCiphertextError);
  });

  it("rejects a value with no v1: prefix (legacy plaintext row) without attempting to decrypt", async () => {
    await expect(decryptToken(KEY_A, "this-looks-like-a-plain-refresh-token")).rejects.toThrow(
      InvalidCiphertextError,
    );
  });

  it("rejects a malformed value with the right prefix but wrong segment count", async () => {
    await expect(decryptToken(KEY_A, "v1:onlyonesegment")).rejects.toThrow(InvalidCiphertextError);
  });
});
