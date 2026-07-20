import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "./types";
import { SESSION_COOKIE_NAME, verifySessionCookieValue } from "./session";

/** sid cookie を検証し、正当なら `profileId` を context に積む。未認証でも先へ進める。 */
export const populateProfileId = createMiddleware<AppEnv>(async (c, next) => {
  const sid = getCookie(c, SESSION_COOKIE_NAME);
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
