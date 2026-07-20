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
export type OAuthState =
  | { nonce: string; mode: "login" }
  | { nonce: string; mode: "add"; profileId: string }
  | { nonce: string; mode: "github"; profileId: string };

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
  const { nonce, mode, profileId } = parsed as Record<string, unknown>;
  if (typeof nonce !== "string" || !nonce) return null;

  if (mode === "add") {
    if (typeof profileId !== "string" || !profileId) return null;
    return { nonce, mode: "add", profileId };
  }
  if (mode === "github") {
    if (typeof profileId !== "string" || !profileId) return null;
    return { nonce, mode: "github", profileId };
  }
  if (mode === "login") {
    return { nonce, mode: "login" };
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
