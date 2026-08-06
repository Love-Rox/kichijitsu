import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildAuthorizationUrl,
  GoogleTokenRefreshError,
  hasRequiredScopes,
  hasTasksScope,
  isPermanentRefreshFailure,
  OAUTH_SCOPES,
  refreshAccessToken,
  revokeToken,
} from "../src/google/oauth";

const EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const CALENDARLIST_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const FULL_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";

describe("hasRequiredScopes", () => {
  it("allows when both required scopes are granted", () => {
    const scope = ["openid", "email", EVENTS_SCOPE, CALENDARLIST_SCOPE].join(" ");
    expect(hasRequiredScopes(scope)).toBe(true);
  });

  it("rejects when calendar.events is missing (granular consent opt-out)", () => {
    const scope = ["openid", "email", CALENDARLIST_SCOPE].join(" ");
    expect(hasRequiredScopes(scope)).toBe(false);
  });

  it("rejects when calendar.calendarlist.readonly is missing", () => {
    const scope = ["openid", "email", EVENTS_SCOPE].join(" ");
    expect(hasRequiredScopes(scope)).toBe(false);
  });

  it("rejects an empty or undefined scope", () => {
    expect(hasRequiredScopes("")).toBe(false);
    expect(hasRequiredScopes(undefined)).toBe(false);
  });

  it("allows existing users who granted the old full calendar scope (superset)", () => {
    const scope = ["openid", "email", FULL_CALENDAR_SCOPE].join(" ");
    expect(hasRequiredScopes(scope)).toBe(true);
  });

  it("does not require the tasks scope (tasks is optional)", () => {
    const scope = ["openid", "email", EVENTS_SCOPE, CALENDARLIST_SCOPE].join(" ");
    expect(hasRequiredScopes(scope)).toBe(true);
  });
});

describe("buildAuthorizationUrl", () => {
  const config = {
    clientId: "client-123",
    clientSecret: "secret",
    redirectUri: "https://kichijitsu.love-rox.cc/auth/callback",
  };

  it("omits login_hint when none is given", () => {
    const url = new URL(buildAuthorizationUrl(config, "state-abc"));
    expect(url.searchParams.has("login_hint")).toBe(false);
    expect(url.searchParams.get("state")).toBe("state-abc");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("sets login_hint when an email is given (account preselect for re-consent)", () => {
    const url = new URL(buildAuthorizationUrl(config, "state-abc", "user@example.com"));
    expect(url.searchParams.get("login_hint")).toBe("user@example.com");
  });

  it("omits login_hint for an empty string", () => {
    const url = new URL(buildAuthorizationUrl(config, "state-abc", ""));
    expect(url.searchParams.has("login_hint")).toBe(false);
  });
});

describe("OAUTH_SCOPES", () => {
  it("requests the tasks scope alongside the calendar scopes", () => {
    expect(OAUTH_SCOPES.split(" ")).toContain(TASKS_SCOPE);
  });
});

describe("hasTasksScope", () => {
  it("returns true when the tasks scope is granted", () => {
    const scope = ["openid", "email", EVENTS_SCOPE, CALENDARLIST_SCOPE, TASKS_SCOPE].join(" ");
    expect(hasTasksScope(scope)).toBe(true);
  });

  it("returns false when the tasks scope is missing (existing user who has not re-consented)", () => {
    const scope = ["openid", "email", EVENTS_SCOPE, CALENDARLIST_SCOPE].join(" ");
    expect(hasTasksScope(scope)).toBe(false);
  });

  it("returns false for an empty or undefined scope", () => {
    expect(hasTasksScope("")).toBe(false);
    expect(hasTasksScope(undefined)).toBe(false);
  });
});

describe("isPermanentRefreshFailure", () => {
  it("HTTP 400 + invalid_grant is permanent (refresh token revoked/expired)", () => {
    expect(isPermanentRefreshFailure(400, "invalid_grant")).toBe(true);
  });

  it("HTTP 400 with a different error code is transient (迷ったら一時的)", () => {
    expect(isPermanentRefreshFailure(400, "invalid_request")).toBe(false);
  });

  it("HTTP 400 with no parseable error code is transient", () => {
    expect(isPermanentRefreshFailure(400, undefined)).toBe(false);
  });

  it("5xx is transient (temporary Google outage)", () => {
    expect(isPermanentRefreshFailure(500, "invalid_grant")).toBe(false);
    expect(isPermanentRefreshFailure(503, undefined)).toBe(false);
  });

  it("429 (rate limited) is transient", () => {
    expect(isPermanentRefreshFailure(429, undefined)).toBe(false);
  });

  it("401 is transient even with an invalid_grant-shaped body (defensive: Google documents 400 for this case)", () => {
    expect(isPermanentRefreshFailure(401, "invalid_grant")).toBe(false);
  });
});

describe("refreshAccessToken", () => {
  const config = { clientId: "client-123", clientSecret: "secret" };

  it("returns the access token on success", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "at-1", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await refreshAccessToken(fetchImpl, config, "refresh-token");

    expect(result).toEqual({ accessToken: "at-1", expiresIn: 3600 });
  });

  it("throws a GoogleTokenRefreshError marked permanent for HTTP 400 invalid_grant", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token expired" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(refreshAccessToken(fetchImpl, config, "dead-refresh-token")).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(GoogleTokenRefreshError);
        const tokenErr = err as GoogleTokenRefreshError;
        expect(tokenErr.status).toBe(400);
        expect(tokenErr.errorCode).toBe("invalid_grant");
        expect(tokenErr.permanent).toBe(true);
        return true;
      },
    );
  });

  it("throws a GoogleTokenRefreshError marked transient for a 5xx response", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("server error", { status: 503 }));

    await expect(refreshAccessToken(fetchImpl, config, "some-refresh-token")).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(GoogleTokenRefreshError);
        const tokenErr = err as GoogleTokenRefreshError;
        expect(tokenErr.status).toBe(503);
        expect(tokenErr.permanent).toBe(false);
        return true;
      },
    );
  });

  it("does not leak the request body (refresh_token/client_secret) into the thrown error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );

    try {
      await refreshAccessToken(fetchImpl, config, "super-secret-refresh-token");
      throw new Error("expected refreshAccessToken to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GoogleTokenRefreshError);
      expect((err as Error).message).not.toContain("super-secret-refresh-token");
      expect((err as Error).message).not.toContain(config.clientSecret);
    }
  });
});

describe("revokeToken", () => {
  it("returns true when Google accepts the revoke request", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const result = await revokeToken(fetchImpl, "some-refresh-token");

    expect(result).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("returns false (without throwing) when Google rejects the revoke, so callers can continue", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("invalid_token", { status: 400 }));

    const result = await revokeToken(fetchImpl, "already-revoked-token");

    expect(result).toBe(false);
  });

  it("returns false (without throwing) on a network error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("network down"));

    const result = await revokeToken(fetchImpl, "some-refresh-token");

    expect(result).toBe(false);
  });
});
