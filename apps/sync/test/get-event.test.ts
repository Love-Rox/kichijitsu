import { describe, expect, it, vi } from "vite-plus/test";
import { getEvent } from "../src/google/get-event";
import { getEventWithRetry, type GetEventCoreDeps } from "../src/core/get-event";

describe("getEvent (google layer)", () => {
  it("GETs events.get URL with a bearer auth header", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ev-1" }), { status: 200 }));

    await getEvent(fetchImpl, "access-token", "primary", "ev-1");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/calendars/primary/events/ev-1");
    expect((init as RequestInit).headers).toEqual({ Authorization: "Bearer access-token" });
  });

  it("URL-encodes calendarId and eventId", () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ev-1" }), { status: 200 }));
    getEvent(fetchImpl, "token", "a/b@example.com", "ev id/1");
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain("/calendars/a%2Fb%40example.com/events/ev%20id%2F1");
  });
});

function makeDeps(fetchImpl: typeof fetch) {
  const forceRefreshAccessToken = vi.fn(async () => "refreshed-access-token");
  const deps: GetEventCoreDeps = {
    fetch: fetchImpl,
    getAccessToken: vi.fn(async () => "valid-access-token"),
    forceRefreshAccessToken,
  };
  return { deps, forceRefreshAccessToken };
}

describe("getEventWithRetry", () => {
  it("returns the event as a GoogleEventDTO on success", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ev-1",
          status: "confirmed",
          extendedProperties: { private: { kichijitsuMirror: "1" } },
        }),
        { status: 200 },
      ),
    );
    const { deps } = makeDeps(fetchImpl);

    const event = await getEventWithRetry(deps, "primary", "ev-1");

    expect(event?.id).toBe("ev-1");
    expect(event?.extendedProperties).toEqual({ private: { kichijitsuMirror: "1" } });
  });

  it("returns null on 404 instead of throwing (already deleted, not a failure)", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 404 }));
    const { deps } = makeDeps(fetchImpl);

    const event = await getEventWithRetry(deps, "primary", "ev-gone");

    expect(event).toBeNull();
  });

  it("refreshes the access token once on 401 and retries", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "ev-1", status: "confirmed" }), { status: 200 }),
      );
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl);

    const event = await getEventWithRetry(deps, "primary", "ev-1");

    expect(event?.id).toBe("ev-1");
    expect(forceRefreshAccessToken).toHaveBeenCalledOnce();
  });

  it("propagates non-ok, non-401, non-404 responses as GoogleApiError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));
    const { deps } = makeDeps(fetchImpl);

    await expect(getEventWithRetry(deps, "primary", "ev-1")).rejects.toThrow(/500/);
  });
});
