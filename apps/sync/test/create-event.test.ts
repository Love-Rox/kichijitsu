import { describe, expect, it, vi } from "vite-plus/test";
import { createEvent } from "../src/google/create-event";
import { toRfc3339Utc } from "../src/google/patch-event";
import { createEventWithRetry, type CreateEventCoreDeps } from "../src/core/create-event";

const PARAMS = {
  calendarId: "primary",
  title: "打ち合わせ",
  startMs: 1_700_000_000_000,
  endMs: 1_700_003_600_000,
  timeZone: "Asia/Tokyo",
};

describe("createEvent", () => {
  it("POSTs events with summary and start/end dateTime+timeZone and a bearer auth header", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "new-event" }), { status: 200 }));

    await createEvent(fetchImpl, "access-token", PARAMS);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
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
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/a%2Fb%40example.com/events");
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
