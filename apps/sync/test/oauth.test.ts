import { describe, expect, it, vi } from "vite-plus/test";
import { hasRequiredScopes, hasTasksScope, OAUTH_SCOPES, revokeToken } from "../src/google/oauth";

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
