import { describe, expect, it, vi } from "vite-plus/test";
import { apiRoutes } from "../src/routes/api";
import { createSessionCookieValue, SESSION_COOKIE_NAME } from "../src/session";

/**
 * `POST /api/event/guests` のルート結線 (ゲストの追加・削除、2026-07-31)。
 *
 * 判断そのもの (isValidEventGuestsRequest / applyGuestChanges) は core の純関数テストで
 * 固めてあるので、ここで確かめるのは「ルートがその判断を正しく使っているか」だけ:
 *
 * - 不正なボディは DO に届く前に 400 で弾かれる (Google に無意味な2往復をさせない)
 * - 差分がそのまま DO の editEventGuests へ渡る
 * - **主催者でない予定は 422 not_organizer** として、他の失敗 (409) と区別して返る
 *   ―― UI が「この予定のゲストは変更できません」という専用の説明を出すため
 *
 * D1/DO は最小限のフェイクを注入する (create-event-route.test.ts と同じ流儀)。
 */

const PROFILE_ID = "profile-1";
const SESSION_SECRET = "test-session-secret";
const ACCOUNT_ID = "acc-1";

function makeFakeDb() {
  return {
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
}

function makeEnv(editEventGuests: ReturnType<typeof vi.fn>): Env {
  return {
    SESSION_SECRET,
    DB: makeFakeDb(),
    USER_SYNC: { getByName: () => ({ editEventGuests }) },
  } as unknown as Env;
}

async function postGuests(env: Env, body: unknown) {
  const sid = await createSessionCookieValue(SESSION_SECRET, PROFILE_ID);
  return apiRoutes.request(
    "/api/event/guests",
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
  eventId: "evt-1",
  addEmails: ["new@example.com"],
};

describe("POST /api/event/guests", () => {
  it("passes the add/remove lists through to the DO", async () => {
    const editEventGuests = vi.fn(async () => ({ ok: true, data: undefined }));
    const res = await postGuests(makeEnv(editEventGuests), {
      ...VALID,
      removeEmails: ["old@example.com"],
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(editEventGuests).toHaveBeenCalledWith(
      ACCOUNT_ID,
      "cal-1",
      "evt-1",
      ["new@example.com"],
      ["old@example.com"],
    );
  });

  it("accepts a removal-only request", async () => {
    const editEventGuests = vi.fn(async () => ({ ok: true, data: undefined }));
    const res = await postGuests(makeEnv(editEventGuests), {
      accountId: ACCOUNT_ID,
      calendarId: "cal-1",
      eventId: "evt-1",
      removeEmails: ["old@example.com"],
    });

    expect(res.status).toBe(200);
    expect(editEventGuests).toHaveBeenCalledWith(ACCOUNT_ID, "cal-1", "evt-1", undefined, [
      "old@example.com",
    ]);
  });

  it("maps not_organizer to 422 (distinct from every other failure)", async () => {
    const editEventGuests = vi.fn(async () => ({
      ok: false,
      status: 422,
      error: "not_organizer",
    }));
    const res = await postGuests(makeEnv(editEventGuests), VALID);

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "not_organizer" });
  });

  it("maps any other Google failure to 409 guests_failed", async () => {
    const editEventGuests = vi.fn(async () => ({
      ok: false,
      status: 403,
      error: "Google Calendar API error: HTTP 403",
    }));
    const res = await postGuests(makeEnv(editEventGuests), VALID);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "guests_failed" });
  });

  it.each([
    ["no change requested", { accountId: ACCOUNT_ID, calendarId: "cal-1", eventId: "evt-1" }],
    ["empty lists", { ...VALID, addEmails: [], removeEmails: [] }],
    ["missing eventId", { ...VALID, eventId: "" }],
    ["address without @", { ...VALID, addEmails: ["not-an-email"] }],
    ["several addresses pasted into one entry", { ...VALID, addEmails: ["a@b.com,c@d.com"] }],
    ["non-array list", { ...VALID, addEmails: "a@b.com" }],
    ["more than 50 addresses", { ...VALID, addEmails: Array(51).fill("a@example.com") }],
  ])("rejects %s with 400 without calling the DO", async (_label, body) => {
    const editEventGuests = vi.fn(async () => ({ ok: true, data: undefined }));
    const res = await postGuests(makeEnv(editEventGuests), body);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_fields" });
    expect(editEventGuests).not.toHaveBeenCalled();
  });

  it("rejects a malformed JSON body with 400 invalid_json", async () => {
    const editEventGuests = vi.fn(async () => ({ ok: true, data: undefined }));
    const sid = await createSessionCookieValue(SESSION_SECRET, PROFILE_ID);
    const res = await apiRoutes.request(
      "/api/event/guests",
      {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${sid}`, "Content-Type": "application/json" },
        body: "{ not json",
      },
      makeEnv(editEventGuests),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
    expect(editEventGuests).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    const editEventGuests = vi.fn(async () => ({ ok: true, data: undefined }));
    const res = await apiRoutes.request(
      "/api/event/guests",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID),
      },
      makeEnv(editEventGuests),
    );

    expect(res.status).toBe(401);
    expect(editEventGuests).not.toHaveBeenCalled();
  });
});
