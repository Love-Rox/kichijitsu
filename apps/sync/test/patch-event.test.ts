import { describe, expect, it, vi } from "vite-plus/test";
import { patchEventTime, toDateOnly, toRfc3339Utc } from "../src/google/patch-event";
import {
  isValidEventPatchRequest,
  patchEventTimeWithRetry,
  type PatchEventCoreDeps,
} from "../src/core/patch-event";

const PARAMS = {
  calendarId: "primary",
  eventId: "event-1",
  startMs: 1_700_000_000_000,
  endMs: 1_700_003_600_000,
  timeZone: "Asia/Tokyo",
};

describe("toRfc3339Utc", () => {
  it("formats an epoch ms as a UTC RFC3339 string", () => {
    expect(toRfc3339Utc(1_700_000_000_000)).toBe("2023-11-14T22:13:20.000Z");
  });
});

describe("patchEventTime", () => {
  it("PATCHes events/{eventId} with start/end dateTime+timeZone and a bearer auth header", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await patchEventTime(fetchImpl, "access-token", PARAMS);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/event-1");
    const requestInit = init as RequestInit;
    expect(requestInit.method).toBe("PATCH");
    expect((requestInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer access-token",
    );
    expect((requestInit.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(requestInit.body as string)).toEqual({
      start: { dateTime: toRfc3339Utc(PARAMS.startMs), timeZone: "Asia/Tokyo" },
      end: { dateTime: toRfc3339Utc(PARAMS.endMs), timeZone: "Asia/Tokyo" },
    });
  });

  it("URL-encodes calendarId and eventId", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await patchEventTime(fetchImpl, "access-token", {
      ...PARAMS,
      calendarId: "a/b@example.com",
      eventId: "event id with spaces",
    });

    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/a%2Fb%40example.com/events/event%20id%20with%20spaces",
    );
  });

  it("omits summary/location/description from the body when not provided (2026-07-22)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await patchEventTime(fetchImpl, "access-token", PARAMS);

    const requestInit = fetchImpl.mock.calls[0][1] as RequestInit;
    const parsedBody = JSON.parse(requestInit.body as string);
    expect(parsedBody).not.toHaveProperty("summary");
    expect(parsedBody).not.toHaveProperty("location");
    expect(parsedBody).not.toHaveProperty("description");
  });

  it("includes only the provided fields (summary/location/description) in the merge body", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await patchEventTime(fetchImpl, "access-token", { ...PARAMS, summary: "New title" });

    const requestInit = fetchImpl.mock.calls[0][1] as RequestInit;
    const parsedBody = JSON.parse(requestInit.body as string);
    expect(parsedBody.summary).toBe("New title");
    expect(parsedBody).not.toHaveProperty("location");
    expect(parsedBody).not.toHaveProperty("description");
  });

  it("sends an empty string as an explicit clear (not omitted)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await patchEventTime(fetchImpl, "access-token", { ...PARAMS, location: "" });

    const requestInit = fetchImpl.mock.calls[0][1] as RequestInit;
    const parsedBody = JSON.parse(requestInit.body as string);
    expect(parsedBody).toHaveProperty("location", "");
  });

  it("sends start/end as date (not dateTime) when isAllDay is true", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await patchEventTime(fetchImpl, "access-token", { ...PARAMS, isAllDay: true });

    const requestInit = fetchImpl.mock.calls[0][1] as RequestInit;
    const parsedBody = JSON.parse(requestInit.body as string);
    expect(parsedBody.start).toEqual({ date: toDateOnly(PARAMS.startMs, PARAMS.timeZone) });
    expect(parsedBody.end).toEqual({ date: toDateOnly(PARAMS.endMs, PARAMS.timeZone) });
  });

  it("sends start/end as dateTime when isAllDay is false/omitted (default)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await patchEventTime(fetchImpl, "access-token", PARAMS);

    const requestInit = fetchImpl.mock.calls[0][1] as RequestInit;
    const parsedBody = JSON.parse(requestInit.body as string);
    expect(parsedBody.start).toEqual({
      dateTime: toRfc3339Utc(PARAMS.startMs),
      timeZone: PARAMS.timeZone,
    });
  });
});

describe("toDateOnly", () => {
  it("formats an epoch ms as YYYY-MM-DD in the given IANA time zone", () => {
    // 2023-11-14T22:13:20.000Z is 2023-11-15 07:13:20 in Asia/Tokyo (UTC+9) — the date
    // component flips across midnight depending on the time zone, which is exactly why
    // this can't just reuse toRfc3339Utc's UTC date.
    expect(toDateOnly(1_700_000_000_000, "Asia/Tokyo")).toBe("2023-11-15");
    expect(toDateOnly(1_700_000_000_000, "UTC")).toBe("2023-11-14");
  });
});

interface DepsOverrides {
  accessToken?: string;
}

function makeDeps(fetchImpl: typeof fetch, overrides: DepsOverrides = {}) {
  const forceRefreshAccessToken = vi.fn(async () => "refreshed-access-token");
  const deps: PatchEventCoreDeps = {
    fetch: fetchImpl,
    getAccessToken: vi.fn(async () => overrides.accessToken ?? "valid-access-token"),
    forceRefreshAccessToken,
  };
  return { deps, forceRefreshAccessToken };
}

describe("patchEventTimeWithRetry", () => {
  it("resolves without error on a successful patch", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const { deps } = makeDeps(fetchImpl);

    await expect(patchEventTimeWithRetry(deps, PARAMS)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws GoogleApiError (without retry) on a 404 (event gone)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl);

    await expect(patchEventTimeWithRetry(deps, PARAMS)).rejects.toThrow(/404/);
    expect(forceRefreshAccessToken).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("propagates 403/412 as GoogleApiError instead of swallowing them", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("precondition failed", { status: 412 }));
    const { deps } = makeDeps(fetchImpl);

    await expect(patchEventTimeWithRetry(deps, PARAMS)).rejects.toThrow(/412/);
  });

  it("refreshes the access token once on 401 and retries the same request", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl, {
      accessToken: "stale-access-token",
    });

    await expect(patchEventTimeWithRetry(deps, PARAMS)).resolves.toBeUndefined();

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

    await expect(patchEventTimeWithRetry(deps, PARAMS)).rejects.toThrow(/401/);
    expect(forceRefreshAccessToken).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

/**
 * 繰り返し予定の適用範囲 (2026-07-30)。「すべての予定」で内容だけを変える場合、親
 * (シリーズ) の start は DTSTART そのものなので、時刻を送らない経路が要る。
 */
describe("patchEventTime — 時刻を送らない (startMs/endMs 未指定)", () => {
  it("start/end のキー自体を body に含めない (Google 側の時刻を保つ)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await patchEventTime(fetchImpl, "access-token", {
      calendarId: "primary",
      eventId: "series-1",
      timeZone: "Asia/Tokyo",
      summary: "新しいタイトル",
    });

    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ summary: "新しいタイトル" });
    expect("start" in body).toBe(false);
    expect("end" in body).toBe(false);
  });
});

describe("isValidEventPatchRequest", () => {
  const VALID = {
    accountId: "acc-1",
    calendarId: "cal-1",
    eventId: "evt-1",
    startMs: 1_700_000_000_000,
    endMs: 1_700_003_600_000,
    timeZone: "Asia/Tokyo",
  };

  it("時刻つきの通常のリクエストを通す", () => {
    expect(isValidEventPatchRequest(VALID)).toBe(true);
  });

  it("startMs/endMs を両方省略したリクエストを通す (時刻に触らない)", () => {
    const { startMs: _s, endMs: _e, ...noTimes } = VALID;
    expect(isValidEventPatchRequest({ ...noTimes, summary: "タイトルだけ" })).toBe(true);
  });

  it("startMs だけ / endMs だけの片側指定は弾く (開始だけ動く予定を作らない)", () => {
    const { startMs: _s, endMs: _e, ...noTimes } = VALID;
    expect(isValidEventPatchRequest({ ...noTimes, startMs: VALID.startMs })).toBe(false);
    expect(isValidEventPatchRequest({ ...noTimes, endMs: VALID.endMs })).toBe(false);
  });

  it("開始 >= 終了 は弾く", () => {
    expect(isValidEventPatchRequest({ ...VALID, endMs: VALID.startMs })).toBe(false);
    expect(isValidEventPatchRequest({ ...VALID, endMs: VALID.startMs - 1 })).toBe(false);
  });

  it("数値でない/有限でない時刻は弾く", () => {
    expect(isValidEventPatchRequest({ ...VALID, startMs: "1700000000000" })).toBe(false);
    expect(isValidEventPatchRequest({ ...VALID, startMs: Number.NaN })).toBe(false);
    expect(isValidEventPatchRequest({ ...VALID, endMs: Number.POSITIVE_INFINITY })).toBe(false);
  });

  it("accountId/calendarId/eventId/timeZone の欠落・空文字を弾く", () => {
    for (const key of ["accountId", "calendarId", "eventId", "timeZone"] as const) {
      expect(isValidEventPatchRequest({ ...VALID, [key]: undefined })).toBe(false);
      expect(isValidEventPatchRequest({ ...VALID, [key]: "" })).toBe(false);
      expect(isValidEventPatchRequest({ ...VALID, [key]: 123 })).toBe(false);
    }
  });

  it("summary/location/description は空文字 (クリア) を許し、文字列以外を弾く", () => {
    expect(isValidEventPatchRequest({ ...VALID, location: "", description: "" })).toBe(true);
    expect(isValidEventPatchRequest({ ...VALID, summary: 1 })).toBe(false);
    expect(isValidEventPatchRequest({ ...VALID, location: {} })).toBe(false);
  });

  it("長すぎる summary/location/description を弾く", () => {
    expect(isValidEventPatchRequest({ ...VALID, summary: "あ".repeat(1025) })).toBe(false);
    expect(isValidEventPatchRequest({ ...VALID, location: "あ".repeat(1025) })).toBe(false);
    expect(isValidEventPatchRequest({ ...VALID, description: "あ".repeat(8193) })).toBe(false);
  });

  it("isAllDay は boolean 以外を弾く (文字列 \"true\" 等の曖昧な指定)", () => {
    expect(isValidEventPatchRequest({ ...VALID, isAllDay: true })).toBe(true);
    expect(isValidEventPatchRequest({ ...VALID, isAllDay: "true" })).toBe(false);
  });

  it("オブジェクトでないボディを弾く", () => {
    expect(isValidEventPatchRequest(null)).toBe(false);
    expect(isValidEventPatchRequest("x")).toBe(false);
    expect(isValidEventPatchRequest([])).toBe(false);
  });
});
