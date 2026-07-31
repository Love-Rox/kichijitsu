import { describe, expect, it, vi } from "vite-plus/test";
import { createEvent } from "../src/google/create-event";
import { toRfc3339Utc } from "../src/google/patch-event";
import {
  createEventWithRetry,
  isValidEventCreateRequest,
  type CreateEventCoreDeps,
} from "../src/core/create-event";

const PARAMS = {
  calendarId: "primary",
  title: "打ち合わせ",
  startMs: 1_700_000_000_000,
  endMs: 1_700_003_600_000,
  timeZone: "Asia/Tokyo",
  // 2026-07-31: google 層は sendUpdates 必須 (google/create-event.ts のコメント参照)
  sendUpdates: "externalOnly",
} as const;

describe("createEvent", () => {
  it("POSTs events with summary and start/end dateTime+timeZone and a bearer auth header", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "new-event" }), { status: 200 }));

    await createEvent(fetchImpl, "access-token", PARAMS);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=externalOnly",
    );
    const requestInit = init as RequestInit;
    expect(requestInit.method).toBe("POST");
    expect((requestInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer access-token",
    );
    expect((requestInit.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(requestInit.body as string)).toEqual({
      summary: "打ち合わせ",
      start: { dateTime: toRfc3339Utc(PARAMS.startMs), timeZone: "Asia/Tokyo" },
      end: { dateTime: toRfc3339Utc(PARAMS.endMs), timeZone: "Asia/Tokyo" },
    });
  });

  it("URL-encodes calendarId", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "new-event" }), { status: 200 }));

    await createEvent(fetchImpl, "access-token", { ...PARAMS, calendarId: "a/b@example.com" });

    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/a%2Fb%40example.com/events?sendUpdates=externalOnly",
    );
  });
});

interface DepsOverrides {
  accessToken?: string;
}

function makeDeps(fetchImpl: typeof fetch, overrides: DepsOverrides = {}) {
  const forceRefreshAccessToken = vi.fn(async () => "refreshed-access-token");
  const deps: CreateEventCoreDeps = {
    fetch: fetchImpl,
    getAccessToken: vi.fn(async () => overrides.accessToken ?? "valid-access-token"),
    forceRefreshAccessToken,
  };
  return { deps, forceRefreshAccessToken };
}

describe("createEventWithRetry", () => {
  it("resolves with the created event id on success", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "created-event-id" }), { status: 200 }),
      );
    const { deps } = makeDeps(fetchImpl);

    await expect(createEventWithRetry(deps, PARAMS)).resolves.toBe("created-event-id");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws GoogleApiError (without retry) on a 403", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl);

    await expect(createEventWithRetry(deps, PARAMS)).rejects.toThrow(/403/);
    expect(forceRefreshAccessToken).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("propagates 412/5xx as GoogleApiError instead of swallowing them", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("server error", { status: 500 }));
    const { deps } = makeDeps(fetchImpl);

    await expect(createEventWithRetry(deps, PARAMS)).rejects.toThrow(/500/);
  });

  it("refreshes the access token once on 401 and retries the same request", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "created-event-id" }), { status: 200 }),
      );
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl, {
      accessToken: "stale-access-token",
    });

    await expect(createEventWithRetry(deps, PARAMS)).resolves.toBe("created-event-id");

    expect(forceRefreshAccessToken).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstAuth = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(firstAuth.Authorization).toBe("Bearer stale-access-token");
    const secondAuth = (fetchImpl.mock.calls[1][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(secondAuth.Authorization).toBe("Bearer refreshed-access-token");
  });

  it("gives up after a second 401 (only retries once)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl);

    await expect(createEventWithRetry(deps, PARAMS)).rejects.toThrow(/401/);
    expect(forceRefreshAccessToken).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

/**
 * 2026-07-29「全項目入力」で events.insert に載せるようになった項目
 * (location / description / 終日) の body 組み立て。
 */
describe("createEvent (全項目入力)", () => {
  function bodyOf(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>): Record<string, unknown> {
    return JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
  }

  function okFetch() {
    return vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "new-event" }), { status: 200 }));
  }

  it("includes location and description when given", async () => {
    const fetchImpl = okFetch();
    await createEvent(fetchImpl, "access-token", {
      ...PARAMS,
      location: "会議室A",
      description: "議題まとめ",
    });
    const body = bodyOf(fetchImpl);
    expect(body.location).toBe("会議室A");
    expect(body.description).toBe("議題まとめ");
  });

  it("omits location/description keys entirely when not given", async () => {
    const fetchImpl = okFetch();
    await createEvent(fetchImpl, "access-token", PARAMS);
    const body = bodyOf(fetchImpl);
    expect("location" in body).toBe(false);
    expect("description" in body).toBe(false);
  });

  it("sends start/end as date (not dateTime) for an all-day event", async () => {
    const fetchImpl = okFetch();
    await createEvent(fetchImpl, "access-token", {
      ...PARAMS,
      // 2026-07-20 0:00 JST 〜 2026-07-21 0:00 JST (排他的な終了 = 7/20 の1日だけ)
      startMs: Date.UTC(2026, 6, 19, 15, 0),
      endMs: Date.UTC(2026, 6, 20, 15, 0),
      isAllDay: true,
    });
    const body = bodyOf(fetchImpl);
    expect(body.start).toEqual({ date: "2026-07-20" });
    expect(body.end).toEqual({ date: "2026-07-21" });
  });
});

/**
 * POST /api/event/create のボディ検証 (2026-07-29 全項目入力)。型ではなく実際の値を
 * 弾けることを確かめる — このエンドポイントは MCP や手書きの curl からも叩ける。
 */
describe("isValidEventCreateRequest", () => {
  const VALID = {
    accountId: "acc-1",
    calendarId: "cal-1",
    title: "打ち合わせ",
    startMs: 1_700_000_000_000,
    endMs: 1_700_003_600_000,
    timeZone: "Asia/Tokyo",
  };

  it("accepts a minimal request (旧クライアント: タイトルと時間帯だけ)", () => {
    expect(isValidEventCreateRequest(VALID)).toBe(true);
  });

  it("accepts location/description/isAllDay", () => {
    expect(
      isValidEventCreateRequest({
        ...VALID,
        location: "会議室A",
        description: "議題",
        isAllDay: true,
      }),
    ).toBe(true);
  });

  it("accepts empty-string location/description (未設定と同じ扱い)", () => {
    expect(isValidEventCreateRequest({ ...VALID, location: "", description: "" })).toBe(true);
  });

  it("rejects a non-object body", () => {
    expect(isValidEventCreateRequest(null)).toBe(false);
    expect(isValidEventCreateRequest("create")).toBe(false);
  });

  it("rejects missing/empty accountId, calendarId, timeZone", () => {
    expect(isValidEventCreateRequest({ ...VALID, accountId: "" })).toBe(false);
    expect(isValidEventCreateRequest({ ...VALID, calendarId: undefined })).toBe(false);
    expect(isValidEventCreateRequest({ ...VALID, timeZone: "" })).toBe(false);
  });

  it("rejects a blank title (空白だけの無題予定を Google 上に作らせない)", () => {
    expect(isValidEventCreateRequest({ ...VALID, title: "   " })).toBe(false);
    expect(isValidEventCreateRequest({ ...VALID, title: "" })).toBe(false);
  });

  it("rejects a non-string title", () => {
    expect(isValidEventCreateRequest({ ...VALID, title: 42 })).toBe(false);
  });

  it("rejects an over-long title/location/description", () => {
    expect(isValidEventCreateRequest({ ...VALID, title: "あ".repeat(1025) })).toBe(false);
    expect(isValidEventCreateRequest({ ...VALID, location: "あ".repeat(1025) })).toBe(false);
    expect(isValidEventCreateRequest({ ...VALID, description: "あ".repeat(8193) })).toBe(false);
    // 上限ちょうどは通す
    expect(isValidEventCreateRequest({ ...VALID, title: "あ".repeat(1024) })).toBe(true);
    expect(isValidEventCreateRequest({ ...VALID, description: "あ".repeat(8192) })).toBe(true);
  });

  it("rejects non-numeric or non-finite startMs/endMs", () => {
    expect(isValidEventCreateRequest({ ...VALID, startMs: "1700000000000" })).toBe(false);
    expect(isValidEventCreateRequest({ ...VALID, endMs: Number.NaN })).toBe(false);
    expect(isValidEventCreateRequest({ ...VALID, endMs: Number.POSITIVE_INFINITY })).toBe(false);
  });

  it("rejects endMs <= startMs (終日も endMs は排他的なので同じ不等号)", () => {
    expect(isValidEventCreateRequest({ ...VALID, endMs: VALID.startMs })).toBe(false);
    expect(isValidEventCreateRequest({ ...VALID, endMs: VALID.startMs - 1 })).toBe(false);
  });

  it("rejects a non-boolean isAllDay (文字列 \"true\" 等の曖昧な指定)", () => {
    expect(isValidEventCreateRequest({ ...VALID, isAllDay: "true" })).toBe(false);
    expect(isValidEventCreateRequest({ ...VALID, isAllDay: 1 })).toBe(false);
  });

  it("rejects a non-string location/description", () => {
    expect(isValidEventCreateRequest({ ...VALID, location: 1 })).toBe(false);
    expect(isValidEventCreateRequest({ ...VALID, description: {} })).toBe(false);
  });
});
