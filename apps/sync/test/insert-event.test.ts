import { describe, expect, it, vi } from "vite-plus/test";
import { insertEvent } from "../src/google/insert-event";
import { insertEventWithRetry, type InsertEventCoreDeps } from "../src/core/insert-event";
import { buildMirrorEventBody } from "../src/core/block-reconcile";
import type { GoogleEventDTO } from "@kichijitsu/shared";

const SOURCE: GoogleEventDTO = {
  id: "ev-1",
  status: "confirmed",
  start: { dateTime: "2026-07-20T10:00:00+09:00", timeZone: "Asia/Tokyo" },
  end: { dateTime: "2026-07-20T11:00:00+09:00", timeZone: "Asia/Tokyo" },
};
const BODY = buildMirrorEventBody(SOURCE, "busy");

describe("insertEvent", () => {
  it("POSTs the body as-is to events.insert with a bearer auth header", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "mirror-1" }), { status: 200 }));

    await insertEvent(fetchImpl, "access-token", { calendarId: "primary", body: BODY });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    const requestInit = init as RequestInit;
    expect(requestInit.method).toBe("POST");
    expect((requestInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer access-token",
    );
    expect(JSON.parse(requestInit.body as string)).toEqual(BODY);
  });

  it("URL-encodes calendarId", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "mirror-1" }), { status: 200 }));

    await insertEvent(fetchImpl, "access-token", { calendarId: "a/b@example.com", body: BODY });

    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/a%2Fb%40example.com/events");
  });
});

function makeDeps(fetchImpl: typeof fetch) {
  const forceRefreshAccessToken = vi.fn(async () => "refreshed-access-token");
  const deps: InsertEventCoreDeps = {
    fetch: fetchImpl,
    getAccessToken: vi.fn(async () => "valid-access-token"),
    forceRefreshAccessToken,
  };
  return { deps, forceRefreshAccessToken };
}

const OOO_SOURCE: GoogleEventDTO = {
  id: "ev-2",
  status: "confirmed",
  start: { dateTime: "2026-07-20T10:00:00+09:00", timeZone: "Asia/Tokyo" },
  end: { dateTime: "2026-07-20T11:00:00+09:00", timeZone: "Asia/Tokyo" },
};
const OOO_BODY = buildMirrorEventBody(OOO_SOURCE, "outOfOffice");

describe("insertEventWithRetry", () => {
  it("resolves with the created mirror event id on success", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "mirror-id-1" }), { status: 200 }));
    const { deps } = makeDeps(fetchImpl);

    await expect(insertEventWithRetry(deps, "primary", BODY)).resolves.toEqual({
      id: "mirror-id-1",
      oooFallback: false,
    });
  });

  it("refreshes the access token once on 401 and retries", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "mirror-id-1" }), { status: 200 }));
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl);

    await expect(insertEventWithRetry(deps, "primary", BODY)).resolves.toEqual({
      id: "mirror-id-1",
      oooFallback: false,
    });
    expect(forceRefreshAccessToken).toHaveBeenCalledOnce();
  });

  it("propagates a 403 (e.g. Workspace outOfOffice rejection) as GoogleApiError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    const { deps } = makeDeps(fetchImpl);

    await expect(insertEventWithRetry(deps, "primary", BODY)).rejects.toThrow(/403/);
  });

  it("falls back to a busy (eventType-stripped) retry when an outOfOffice body gets a 400", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "mirror-fallback-1" }), { status: 200 }),
      );
    const { deps } = makeDeps(fetchImpl);

    await expect(insertEventWithRetry(deps, "primary", OOO_BODY)).resolves.toEqual({
      id: "mirror-fallback-1",
      oooFallback: true,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const retriedInit = fetchImpl.mock.calls[1][1] as RequestInit;
    const retriedBody = JSON.parse(retriedInit.body as string);
    expect(retriedBody).not.toHaveProperty("eventType");
  });

  it("falls back to a busy retry when an outOfOffice body gets a 403", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "mirror-fallback-2" }), { status: 200 }),
      );
    const { deps } = makeDeps(fetchImpl);

    await expect(insertEventWithRetry(deps, "primary", OOO_BODY)).resolves.toEqual({
      id: "mirror-fallback-2",
      oooFallback: true,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const retriedInit = fetchImpl.mock.calls[1][1] as RequestInit;
    const retriedBody = JSON.parse(retriedInit.body as string);
    expect(retriedBody).not.toHaveProperty("eventType");
  });

  it("throws GoogleApiError when the outOfOffice fallback retry itself fails", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }))
      .mockResolvedValueOnce(new Response("server error", { status: 500 }));
    const { deps } = makeDeps(fetchImpl);

    await expect(insertEventWithRetry(deps, "primary", OOO_BODY)).rejects.toThrow(/500/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not fall back for a busy body (no eventType) that gets a 400", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    const { deps } = makeDeps(fetchImpl);

    await expect(insertEventWithRetry(deps, "primary", BODY)).rejects.toThrow(/400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not fall back for an outOfOffice body on a non-400/403 4xx (e.g. 429)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    const { deps } = makeDeps(fetchImpl);

    await expect(insertEventWithRetry(deps, "primary", OOO_BODY)).rejects.toThrow(/429/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
