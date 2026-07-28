import { describe, expect, it, vi } from "vite-plus/test";
import { apiRoutes } from "../src/routes/api";
import { createSessionCookieValue, SESSION_COOKIE_NAME } from "../src/session";

/**
 * `POST /api/event/create` のルート結線 (2026-07-29「全項目入力」)。
 *
 * 判断そのもの (isValidEventCreateRequest) は core/create-event.ts の純関数テストで
 * 固めてあるので、ここで確かめるのは「ルートがその判断を正しく使っているか」だけ:
 *
 * - **不正なボディは DO に届く前に 400 で弾かれる** (Google 側に無題や逆転した時間帯の
 *   予定を作らせない)
 * - 正しいボディでは location/description/isAllDay が DO の createEvent までそのまま渡る
 *
 * D1/DO は最小限のフェイクを注入する (block-rules-route.test.ts と同じ流儀。実バインディングは
 * 使わない)。
 */

const PROFILE_ID = "profile-1";
const SESSION_SECRET = "test-session-secret";
const ACCOUNT_ID = "acc-1";

/** accounts の profile_id 引きだけに答える D1 の最小フェイク。 */
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

function makeEnv(createEvent: ReturnType<typeof vi.fn>): Env {
  return {
    SESSION_SECRET,
    DB: makeFakeDb(),
    USER_SYNC: { getByName: () => ({ createEvent }) },
  } as unknown as Env;
}

async function postCreate(env: Env, body: unknown) {
  const sid = await createSessionCookieValue(SESSION_SECRET, PROFILE_ID);
  return apiRoutes.request(
    "/api/event/create",
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
  title: "打ち合わせ",
  startMs: 1_700_000_000_000,
  endMs: 1_700_003_600_000,
  timeZone: "Asia/Tokyo",
};

describe("POST /api/event/create", () => {
  it("passes location/description/isAllDay through to the DO", async () => {
    const createEvent = vi.fn(async () => ({ ok: true, data: "created-id" }));
    const res = await postCreate(makeEnv(createEvent), {
      ...VALID,
      location: "会議室A",
      description: "議題まとめ",
      isAllDay: true,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, eventId: "created-id" });
    expect(createEvent).toHaveBeenCalledWith(
      ACCOUNT_ID,
      "cal-1",
      "打ち合わせ",
      VALID.startMs,
      VALID.endMs,
      "Asia/Tokyo",
      { location: "会議室A", description: "議題まとめ", isAllDay: true },
    );
  });

  it("still accepts a request without the new fields (旧クライアント)", async () => {
    const createEvent = vi.fn(async () => ({ ok: true, data: "created-id" }));
    const res = await postCreate(makeEnv(createEvent), VALID);

    expect(res.status).toBe(200);
    expect(createEvent).toHaveBeenCalledWith(
      ACCOUNT_ID,
      "cal-1",
      "打ち合わせ",
      VALID.startMs,
      VALID.endMs,
      "Asia/Tokyo",
      { location: undefined, description: undefined, isAllDay: undefined },
    );
  });

  it.each([
    ["blank title", { ...VALID, title: "   " }],
    ["endMs <= startMs", { ...VALID, endMs: VALID.startMs }],
    ["non-string location", { ...VALID, location: 42 }],
    ["non-boolean isAllDay", { ...VALID, isAllDay: "true" }],
    ["over-long description", { ...VALID, description: "あ".repeat(8193) }],
    ["missing timeZone", { ...VALID, timeZone: "" }],
  ])("rejects %s with 400 without calling the DO", async (_label, body) => {
    const createEvent = vi.fn(async () => ({ ok: true, data: "created-id" }));
    const res = await postCreate(makeEnv(createEvent), body);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_fields" });
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("rejects a malformed JSON body with 400 invalid_json", async () => {
    const createEvent = vi.fn(async () => ({ ok: true, data: "created-id" }));
    const sid = await createSessionCookieValue(SESSION_SECRET, PROFILE_ID);
    const res = await apiRoutes.request(
      "/api/event/create",
      {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${sid}`, "Content-Type": "application/json" },
        body: "{ not json",
      },
      makeEnv(createEvent),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
    expect(createEvent).not.toHaveBeenCalled();
  });
});
