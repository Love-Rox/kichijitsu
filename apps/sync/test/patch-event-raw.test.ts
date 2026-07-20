import { describe, expect, it, vi } from "vite-plus/test";
import { patchEventRaw } from "../src/google/patch-event-raw";
import { patchEventRawWithRetry, type PatchEventRawCoreDeps } from "../src/core/patch-event-raw";

const PARAMS = {
  calendarId: "primary",
  eventId: "mirror-1",
  start: { dateTime: "2026-07-20T10:00:00+09:00", timeZone: "Asia/Tokyo" },
  end: { dateTime: "2026-07-20T11:00:00+09:00", timeZone: "Asia/Tokyo" },
};

describe("patchEventRaw", () => {
  it("PATCHes events/{eventId} with start/end passed through as-is", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await patchEventRaw(fetchImpl, "access-token", PARAMS);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/mirror-1");
    const requestInit = init as RequestInit;
    expect(requestInit.method).toBe("PATCH");
    expect(JSON.parse(requestInit.body as string)).toEqual({
      start: PARAMS.start,
      end: PARAMS.end,
    });
  });

  it("supports all-day (date-only) start/end", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const allDayParams = {
      ...PARAMS,
      start: { date: "2026-07-20" },
      end: { date: "2026-07-21" },
    };

    await patchEventRaw(fetchImpl, "access-token", allDayParams);

    const requestInit = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(requestInit.body as string)).toEqual({
      start: { date: "2026-07-20" },
      end: { date: "2026-07-21" },
    });
  });
});

function makeDeps(fetchImpl: typeof fetch) {
  const forceRefreshAccessToken = vi.fn(async () => "refreshed-access-token");
  const deps: PatchEventRawCoreDeps = {
    fetch: fetchImpl,
    getAccessToken: vi.fn(async () => "valid-access-token"),
    forceRefreshAccessToken,
  };
  return { deps, forceRefreshAccessToken };
}

describe("patchEventRawWithRetry", () => {
  it("resolves without error on a successful patch", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const { deps } = makeDeps(fetchImpl);

    await expect(patchEventRawWithRetry(deps, PARAMS)).resolves.toBeUndefined();
  });

  it("refreshes the access token once on 401 and retries the same request", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl);

    await expect(patchEventRawWithRetry(deps, PARAMS)).resolves.toBeUndefined();
    expect(forceRefreshAccessToken).toHaveBeenCalledOnce();
  });

  it("propagates a 404 as GoogleApiError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));
    const { deps } = makeDeps(fetchImpl);

    await expect(patchEventRawWithRetry(deps, PARAMS)).rejects.toThrow(/404/);
  });
});
