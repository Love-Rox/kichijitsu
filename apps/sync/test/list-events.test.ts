import { describe, expect, it, vi } from "vite-plus/test";
import { buildListEventsInWindowUrl, fetchEventsInWindowPage } from "../src/google/list-events";
import {
  listEventsInWindowWithRetry,
  type ListEventsInWindowCoreDeps,
} from "../src/core/list-events";

const WINDOW = { timeMin: "2026-07-19T00:00:00.000Z", timeMax: "2026-09-17T00:00:00.000Z" };

describe("buildListEventsInWindowUrl", () => {
  it("sets singleEvents=true, showDeleted=false, timeMin/timeMax, maxResults=250, orderBy=startTime", () => {
    const url = new URL(buildListEventsInWindowUrl("primary", WINDOW));
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(url.searchParams.get("showDeleted")).toBe("false");
    expect(url.searchParams.get("timeMin")).toBe(WINDOW.timeMin);
    expect(url.searchParams.get("timeMax")).toBe(WINDOW.timeMax);
    expect(url.searchParams.get("maxResults")).toBe("250");
    expect(url.searchParams.get("orderBy")).toBe("startTime");
    expect(url.searchParams.has("pageToken")).toBe(false);
  });

  it("URL-encodes calendarId", () => {
    const url = buildListEventsInWindowUrl("a/b@example.com", WINDOW);
    expect(url).toContain("/calendars/a%2Fb%40example.com/events");
  });

  it("includes pageToken when given", () => {
    const url = new URL(buildListEventsInWindowUrl("primary", { ...WINDOW, pageToken: "page-2" }));
    expect(url.searchParams.get("pageToken")).toBe("page-2");
  });
});

describe("fetchEventsInWindowPage", () => {
  it("GETs the events.list URL with a bearer auth header", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));

    await fetchEventsInWindowPage(fetchImpl, "access-token", "primary", WINDOW);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/calendars/primary/events");
    expect((init as RequestInit).headers).toEqual({ Authorization: "Bearer access-token" });
  });
});

function makeDeps(fetchImpl: typeof fetch) {
  const forceRefreshAccessToken = vi.fn(async () => "refreshed-access-token");
  const deps: ListEventsInWindowCoreDeps = {
    fetch: fetchImpl,
    getAccessToken: vi.fn(async () => "valid-access-token"),
    forceRefreshAccessToken,
  };
  return { deps, forceRefreshAccessToken };
}

function rawEvent(id: string, overrides: Record<string, unknown> = {}) {
  return { id, status: "confirmed", ...overrides };
}

describe("listEventsInWindowWithRetry", () => {
  it("returns the events from a single page", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [rawEvent("ev-1"), rawEvent("ev-2")] }), {
        status: 200,
      }),
    );
    const { deps } = makeDeps(fetchImpl);

    const events = await listEventsInWindowWithRetry(deps, "primary", WINDOW);

    expect(events.map((e) => e.id)).toEqual(["ev-1", "ev-2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("follows nextPageToken and combines results across pages", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [rawEvent("ev-1")], nextPageToken: "page-2" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [rawEvent("ev-2")] }), { status: 200 }),
      );
    const { deps } = makeDeps(fetchImpl);

    const events = await listEventsInWindowWithRetry(deps, "primary", WINDOW);

    expect(events.map((e) => e.id)).toEqual(["ev-1", "ev-2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondUrl = new URL(fetchImpl.mock.calls[1][0] as string);
    expect(secondUrl.searchParams.get("pageToken")).toBe("page-2");
  });

  it("maps extendedProperties through to the DTO (needed for mirror detection)", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [rawEvent("ev-1", { extendedProperties: { private: { kichijitsuMirror: "1" } } })],
        }),
        { status: 200 },
      ),
    );
    const { deps } = makeDeps(fetchImpl);

    const events = await listEventsInWindowWithRetry(deps, "primary", WINDOW);

    expect(events[0].extendedProperties).toEqual({ private: { kichijitsuMirror: "1" } });
  });

  it("refreshes the access token once on 401 and retries the same page", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [rawEvent("ev-1")] }), { status: 200 }),
      );
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl);

    const events = await listEventsInWindowWithRetry(deps, "primary", WINDOW);

    expect(events.map((e) => e.id)).toEqual(["ev-1"]);
    expect(forceRefreshAccessToken).toHaveBeenCalledOnce();
  });

  it("propagates non-ok, non-401 responses as GoogleApiError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));
    const { deps } = makeDeps(fetchImpl);

    await expect(listEventsInWindowWithRetry(deps, "primary", WINDOW)).rejects.toThrow(/500/);
  });
});
