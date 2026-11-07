import { describe, expect, it, vi } from "vite-plus/test";
import { apiRoutes } from "../src/routes/api";
import { createSessionCookieValue, SESSION_COOKIE_NAME } from "../src/session";

/** `POST /api/event/guests-following` のルート結線 (「これ以降」の分割、2026-11-07)。 */

const PROFILE_ID = "profile-1";
const SESSION_SECRET = "test-session-secret";
const ACCOUNT_ID = "acc-1";

const fakeDb = {
  prepare() {
    return {
      bind() {
        return {
          first: async () => ({ profile_id: PROFILE_ID }),
          all: async () => ({ results: [] }),
          run: async () => ({ success: true }),
        };
      },
    };
  },
};

function makeEnv(editEventGuestsFollowing: ReturnType<typeof vi.fn>): Env {
  return {
    SESSION_SECRET,
    DB: fakeDb,
    USER_SYNC: { getByName: () => ({ editEventGuestsFollowing }) },
  } as unknown as Env;
}

async function post(env: Env, body: unknown) {
  const sid = await createSessionCookieValue(SESSION_SECRET, PROFILE_ID);
  return apiRoutes.request(
    "/api/event/guests-following",
    {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sid}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

const VALID = {
  accountId: ACCOUNT_ID,
  calendarId: "cal-1",
  eventId: "series_20261124T190000Z",
  addEmails: ["new@example.com"],
};

describe("POST /api/event/guests-following", () => {
  it("passes the change to the DO and reports meetDropped", async () => {
    const fn = vi.fn(async () => ({
      ok: true,
      data: { noop: false, newEventId: "new", meetDropped: true },
    }));
    const res = await post(makeEnv(fn), VALID);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, meetDropped: true });
    expect(fn).toHaveBeenCalledWith(ACCOUNT_ID, "cal-1", VALID.eventId, ["new@example.com"], undefined);
  });

  it("rejects an invalid body before reaching the DO", async () => {
    const fn = vi.fn();
    const res = await post(makeEnv(fn), { ...VALID, addEmails: [] });

    expect(res.status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });

  it("returns 422 split_unsupported with the machine-readable reason", async () => {
    const fn = vi.fn(async () => ({
      ok: false,
      status: 422,
      error: "split_unsupported:count_rule",
    }));
    const res = await post(makeEnv(fn), VALID);

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "split_unsupported", reason: "count_rule" });
  });

  it("returns 422 not_organizer", async () => {
    const fn = vi.fn(async () => ({ ok: false, status: 422, error: "not_organizer" }));
    const res = await post(makeEnv(fn), VALID);

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "not_organizer" });
  });

  it("maps any other failure to 409", async () => {
    const fn = vi.fn(async () => ({ ok: false, status: 500, error: "boom" }));
    const res = await post(makeEnv(fn), VALID);

    expect(res.status).toBe(409);
  });
});
