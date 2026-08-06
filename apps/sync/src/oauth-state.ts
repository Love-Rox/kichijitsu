import { isValidDesktopHex32 } from "./core/desktop-auth";

/**
 * /auth/login → /auth/callback の間で `state` パラメータ (= state cookie の値でもある)
 * に載せる構造化ペイロード。
 *
 * CSRF 対策は「state cookie の値と、callback に返ってくる state クエリparamが完全一致
 * するか」で担保している (Google は受け取った state をそのまま素通しで返すだけであり、
 * cookie は HttpOnly + 同一オリジン限定なので第三者は書き換えられない)。したがってここに
 * 積む mode/profileId は、それ単体を別途署名しなくても改ざん耐性を持つ — 一致検証さえ
 * 通れば、このサーバー自身が /auth/login で発行した値そのものだと保証されるため。
 */
// 判別可能なユニオンにしているのは、`state.mode === 'add'` で分岐した先で
// `state.profileId` が確実に string だと TypeScript に narrowing させるため
// (フラットな `profileId?: string` だと呼び出し側で毎回 non-null assertion が要る)。
//
// "github" (docs/github-oauth.md、2026-07-20) は GitHub App の user-to-server 連携用。
// Google の "add" (=既存プロファイルに Google アカウントを追加) とは意味が異なる
// (Google アカウントではなく GitHub アカウントを既存プロファイルにぶら下げる) ため
// 別モードとして区別する。ただし CSRF 対策としての state cookie は Google と別名
// (routes/github-auth.ts の GITHUB_STATE_COOKIE_NAME) を使うので、この型自体が
// Google の state と混ざることは無い — mode を分けるのは「callback 側で意図を
// 取り違えない」ための型安全性のためであり、CSRF 対策そのものではない。
//
// desktopChallenge (2026-08-07) は「この OAuth はデスクトップ版が外部ブラウザで
// 始めたもの」という印で、値は SHA-256(アプリが保持する verifier) の hex
// (core/desktop-auth.ts 参照)。callback 側は、これが載っていれば sid cookie を
// 張らずに使い捨てチケットを発行してアプリへ返す。
// **省略可能** にしてあるのが要点 ―― ブラウザ版/PWA は常に undefined を渡し、
// JSON.stringify は undefined のキーを落とすので、従来と1バイトも変わらない state が
// 生成される (= ブラウザ経路の挙動は不変)。
export type OAuthState =
  | { nonce: string; mode: "login"; desktopChallenge?: string }
  | { nonce: string; mode: "add"; profileId: string; desktopChallenge?: string }
  // GitHub 連携はデスクトップ版でも従来どおり webview 内で完結する (今回の
  // disabled_client は Google 固有の制約で、GitHub は埋め込みブラウザを禁じていない)。
  // 型として `desktopChallenge?: undefined` を明示しているのは、`state.desktopChallenge`
  // をユニオン全体に対して素直に参照できるようにするため ―― 値は常に undefined。
  | { nonce: string; mode: "github"; profileId: string; desktopChallenge?: undefined };

export function encodeOAuthState(state: OAuthState): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(state)));
}

/** 壊れている/改ざんされている/形が不正な値は null。 */
export function decodeOAuthState(value: string): OAuthState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(value)));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { nonce, mode, profileId, desktopChallenge } = parsed as Record<string, unknown>;
  if (typeof nonce !== "string" || !nonce) return null;

  // desktopChallenge は「無い」か「正しい形式の hex 64 文字」のどちらかしか許さない。
  // 中途半端な値を素通しすると callback 側の分岐 (`state.desktopChallenge` の有無) が
  // 意図せず立ってしまうため、形が違えば state ごと不正扱いにして落とす (fail closed)。
  let challenge: string | undefined;
  if (desktopChallenge !== undefined) {
    if (typeof desktopChallenge !== "string" || !isValidDesktopHex32(desktopChallenge)) return null;
    challenge = desktopChallenge;
  }

  if (mode === "add") {
    if (typeof profileId !== "string" || !profileId) return null;
    return { nonce, mode: "add", profileId, desktopChallenge: challenge };
  }
  if (mode === "github") {
    if (typeof profileId !== "string" || !profileId) return null;
    return { nonce, mode: "github", profileId };
  }
  if (mode === "login") {
    return { nonce, mode: "login", desktopChallenge: challenge };
  }
  return null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
