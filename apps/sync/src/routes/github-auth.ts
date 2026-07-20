import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../types";
import {
  STATE_COOKIE_MAX_AGE,
  GITHUB_STATE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  verifySessionCookieValue,
} from "../session";
import { buildGitHubAuthorizationUrl, exchangeGitHubCode, fetchGitHubUser } from "../github/oauth";
import { isHttpsRequest } from "../http";
import { encryptToken } from "../crypto";
import { encodeOAuthState, decodeOAuthState } from "../oauth-state";

/**
 * GitHub App の user-to-server OAuth 連携 (docs/github-oauth.md、2026-07-20)。Google
 * (routes/auth.ts) と同じ骨格 (state cookie による CSRF 対策 → authorize へ redirect →
 * code 交換 → 暗号化して保存) を踏襲するが、以下が異なる:
 * - GitHub は常に「既存プロファイルへの追加」(要ログイン)。新規プロファイルを作る
 *   経路は無い (Google でまずログインしてから GitHub を連携する想定)。
 * - state cookie は Google と別名 (GITHUB_STATE_COOKIE_NAME) にして混ざらないようにする。
 * - 今回のスコープでは issue/PR 等の取得・同期はしない (連携の土台のみ)。
 */
export const githubAuthRoutes = new Hono<AppEnv>();

function redirectUriFor(env: { GITHUB_REDIRECT_URL?: string }, requestUrl: string): string {
  // Google の redirectUriFor (routes/auth.ts) と同じ理由: wrangler dev は routes があると
  // リクエスト URL を本番ホストでシミュレートするため、ローカルでは .dev.vars の
  // GITHUB_REDIRECT_URL (http://localhost:8787/auth/github/callback) で明示上書きする。
  if (env.GITHUB_REDIRECT_URL) return env.GITHUB_REDIRECT_URL;
  return new URL("/auth/github/callback", requestUrl).toString();
}

githubAuthRoutes.get("/auth/github/login", async (c) => {
  const sid = getCookie(c, SESSION_COOKIE_NAME);
  const profileId = sid ? await verifySessionCookieValue(c.env.SESSION_SECRET, sid) : null;
  if (!profileId) {
    // GitHub 連携は既存プロファイルにぶら下げる (要ログイン)。未ログインならまず
    // Google でログインしてもらう必要があるので、エラーを載せて APP_URL に戻す。
    const deniedUrl = new URL(c.env.APP_URL);
    deniedUrl.searchParams.set("auth_error", "login_required");
    return c.redirect(deniedUrl.toString(), 302);
  }

  const nonce = crypto.randomUUID();
  const state = encodeOAuthState({ nonce, mode: "github", profileId });

  setCookie(c, GITHUB_STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: isHttpsRequest(c.req.url),
    sameSite: "Lax",
    path: "/",
    maxAge: STATE_COOKIE_MAX_AGE,
  });

  const authorizationUrl = buildGitHubAuthorizationUrl(
    { clientId: c.env.GITHUB_CLIENT_ID },
    state,
    redirectUriFor(c.env, c.req.url),
  );

  return c.redirect(authorizationUrl, 302);
});

githubAuthRoutes.get("/auth/github/callback", async (c) => {
  const code = c.req.query("code");
  const returnedState = c.req.query("state");
  const oauthError = c.req.query("error");
  const cookieState = getCookie(c, GITHUB_STATE_COOKIE_NAME);
  deleteCookie(c, GITHUB_STATE_COOKIE_NAME, { path: "/" });

  const failWith = (authError: string) => {
    const deniedUrl = new URL(c.env.APP_URL);
    deniedUrl.searchParams.set("auth_error", authError);
    return c.redirect(deniedUrl.toString(), 302);
  };

  if (oauthError) {
    return failWith(`github_oauth_error: ${oauthError}`);
  }
  if (!code || !returnedState || !cookieState || returnedState !== cookieState) {
    return failWith("invalid_oauth_state");
  }
  const state = decodeOAuthState(cookieState);
  if (!state || state.mode !== "github") {
    return failWith("invalid_oauth_state");
  }
  const profileId = state.profileId;

  let accessToken: string;
  let scope: string | undefined;
  try {
    const tokens = await exchangeGitHubCode(
      fetch,
      { clientId: c.env.GITHUB_CLIENT_ID, clientSecret: c.env.GITHUB_CLIENT_SECRET },
      code,
      redirectUriFor(c.env, c.req.url),
    );
    accessToken = tokens.accessToken;
    scope = tokens.scope;
  } catch (err) {
    console.error("GitHub token exchange failed", err);
    return failWith("github_token_exchange_failed");
  }

  let githubUserId: number;
  let githubLogin: string;
  try {
    const user = await fetchGitHubUser(fetch, accessToken);
    githubUserId = user.id;
    githubLogin = user.login;
  } catch (err) {
    console.error("GitHub user fetch failed", err);
    return failWith("github_user_fetch_failed");
  }

  const encryptedToken = await encryptToken(c.env.TOKEN_ENC_KEY, accessToken);

  await c.env.DB.prepare(
    `INSERT INTO github_connections (profile_id, github_user_id, github_login, access_token, scope, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id) DO UPDATE SET
       github_user_id = excluded.github_user_id,
       github_login = excluded.github_login,
       access_token = excluded.access_token,
       scope = excluded.scope`,
  )
    .bind(profileId, githubUserId, githubLogin, encryptedToken, scope ?? null, Date.now())
    .run();

  return c.redirect(c.env.APP_URL, 302);
});
