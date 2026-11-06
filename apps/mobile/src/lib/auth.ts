import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { API_BASE, AUTH_CALLBACK_URL } from "./config";

const TOKEN_KEY = "kichijitsu.session";

/**
 * ログインの流れ (デスクトップ版と同じ、チケットと verifier の交換):
 *   1. アプリが verifier(ランダム 32 バイトの hex)を作り、challenge = SHA-256(verifier) を付けて
 *      /auth/login?desktop=1&dc=<challenge> をシステムのブラウザシートで開く
 *   2. Google の同意 → サーバーが使い捨てのチケットを発行し、kichijitsu://auth?ticket=... へ戻す
 *   3. アプリが ticket + verifier を POST /auth/mobile/exchange に渡し、セッション値を受け取る
 *   4. セッション値は Keychain (SecureStore) に保存し、以後 Authorization: Bearer で API を呼ぶ
 * verifier はアプリの中にしか無いので、チケットだけを横取りされても交換できない。
 */
export async function signIn(): Promise<boolean> {
  const verifier = Array.from(Crypto.getRandomBytes(32), (b) => b.toString(16).padStart(2, "0")).join("");
  const challenge = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: Crypto.CryptoEncoding.HEX,
  });

  const url = `${API_BASE}/auth/login?desktop=1&dc=${challenge}`;
  const result = await WebBrowser.openAuthSessionAsync(url, AUTH_CALLBACK_URL);
  if (result.type !== "success") return false;

  const ticket = new URL(result.url).searchParams.get("ticket");
  if (!ticket) throw new Error("チケットを受け取れませんでした");

  const res = await fetch(`${API_BASE}/auth/mobile/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket, verifier }),
  });
  if (!res.ok) throw new Error(`ログインに失敗しました (${res.status})`);
  const { token } = (await res.json()) as { token: string };
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  return true;
}

export async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function signOut(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

/**
 * いまのセッション値の指紋 (SHA-256)。手元に保存した予定が「このセッションのもの」かを確かめるのに使う
 * (保存時に meta へ残し、読み込み時に照合する)。セッション値そのものは保存しない。未ログインなら null。
 */
export async function sessionFingerprint(): Promise<string | null> {
  const token = await getToken();
  if (!token) return null;
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, token, {
    encoding: Crypto.CryptoEncoding.HEX,
  });
}
