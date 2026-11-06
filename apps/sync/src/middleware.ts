import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "./types";
import { SESSION_COOKIE_NAME, verifySessionCookieValue } from "./session";

/** `Authorization: Bearer <値>` から値を取り出す。形式が違えば undefined。 */
function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1];
}

/**
 * セッションを検証し、正当なら `profileId` を context に積む。未認証でも先へ進める。
 *
 * ブラウザ・デスクトップは sid cookie。**モバイルアプリ (2026-11-06) は
 * `Authorization: Bearer <セッション値>`** で同じ値を送る (値は sid cookie と同じ署名・形式、
 * POST /auth/mobile/exchange で受け取る)。cookie があればそちらを優先する。
 * Bearer は暗黙には付かない (ブラウザが勝手に送らない) ので、cookie と違って CSRF の経路にならない。
 */
export const populateProfileId = createMiddleware<AppEnv>(async (c, next) => {
  const sid = getCookie(c, SESSION_COOKIE_NAME) ?? bearerToken(c.req.header("Authorization"));
  if (sid) {
    const profileId = await verifySessionCookieValue(c.env.SESSION_SECRET, sid);
    if (profileId) {
      c.set("profileId", profileId);
    }
  }
  await next();
});

/** `profileId` が積まれていなければ 401 を返す。populateProfileId の後段で使う。 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get("profileId")) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});
