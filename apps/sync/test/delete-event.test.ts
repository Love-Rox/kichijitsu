import { describe, expect, it, vi } from "vite-plus/test";
import { deleteEvent } from "../src/google/delete-event";
import { deleteEventWithRetry, type DeleteEventCoreDeps } from "../src/core/delete-event";

const PARAMS = {
  calendarId: "primary",
  eventId: "event-1",
};

describe("deleteEvent", () => {
  it("DELETEs events/{eventId} with a bearer auth header", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await deleteEvent(fetchImpl, "access-token", PARAMS);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/event-1");
    const requestInit = init as RequestInit;
    expect(requestInit.method).toBe("DELETE");
    expect((requestInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer access-token",
    );
  });

  it("URL-encodes calendarId and eventId", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await deleteEvent(fetchImpl, "access-token", {
      calendarId: "a/b@example.com",
      eventId: "event id with spaces",
    });

    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/a%2Fb%40example.com/events/event%20id%20with%20spaces",
    );
  });
});

interface DepsOverrides {
  accessToken?: string;
}

function makeDeps(fetchImpl: typeof fetch, overrides: DepsOverrides = {}) {
  const forceRefreshAccessToken = vi.fn(async () => "refreshed-access-token");
  const deps: DeleteEventCoreDeps = {
    fetch: fetchImpl,
    getAccessToken: vi.fn(async () => overrides.accessToken ?? "valid-access-token"),
    forceRefreshAccessToken,
  };
  return { deps, forceRefreshAccessToken };
}

describe("deleteEventWithRetry", () => {
  it("resolves without error on a successful 204 delete", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const { deps } = makeDeps(fetchImpl);

    await expect(deleteEventWithRetry(deps, PARAMS)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("resolves without error on a successful 200 delete", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const { deps } = makeDeps(fetchImpl);

    await expect(deleteEventWithRetry(deps, PARAMS)).resolves.toBeUndefined();
  });

  it("treats a 404 (already deleted) as success (idempotent)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl);

    await expect(deleteEventWithRetry(deps, PARAMS)).resolves.toBeUndefined();
    expect(forceRefreshAccessToken).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("propagates 403/412/5xx as GoogleApiError instead of swallowing them", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("precondition failed", { status: 412 }));
    const { deps } = makeDeps(fetchImpl);

    await expect(deleteEventWithRetry(deps, PARAMS)).rejects.toThrow(/412/);
  });

  it("refreshes the access token once on 401 and retries the same request", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl, {
      accessToken: "stale-access-token",
    });

    await expect(deleteEventWithRetry(deps, PARAMS)).resolves.toBeUndefined();

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

    await expect(deleteEventWithRetry(deps, PARAMS)).rejects.toThrow(/401/);
    expect(forceRefreshAccessToken).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
