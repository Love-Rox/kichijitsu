import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildScanMirrorEventsUrl,
  fetchScanMirrorEventsPage,
} from "../src/google/scan-mirror-events";
import {
  scanMirrorEventsWithRetry,
  type ScanMirrorEventsCoreDeps,
} from "../src/core/scan-mirror-events";

describe("buildScanMirrorEventsUrl", () => {
  it("sets privateExtendedProperty=kichijitsuMirror=1, singleEvents=false, maxResults=250, no timeMin/timeMax", () => {
    const url = new URL(buildScanMirrorEventsUrl("primary", {}));
    expect(url.searchParams.get("privateExtendedProperty")).toBe("kichijitsuMirror=1");
    expect(url.searchParams.get("singleEvents")).toBe("false");
    expect(url.searchParams.get("maxResults")).toBe("250");
    expect(url.searchParams.has("timeMin")).toBe(false);
    expect(url.searchParams.has("timeMax")).toBe(false);
    expect(url.searchParams.has("pageToken")).toBe(false);
  });

  it("URL-encodes calendarId", () => {
    const url = buildScanMirrorEventsUrl("a/b@example.com", {});
    expect(url).toContain("/calendars/a%2Fb%40example.com/events");
  });

  it("includes pageToken when given", () => {
    const url = new URL(buildScanMirrorEventsUrl("primary", { pageToken: "page-2" }));
    expect(url.searchParams.get("pageToken")).toBe("page-2");
  });
});

describe("fetchScanMirrorEventsPage", () => {
  it("GETs the events.list URL with a bearer auth header", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));

    await fetchScanMirrorEventsPage(fetchImpl, "access-token", "primary", {});

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/calendars/primary/events");
    expect((init as RequestInit).headers).toEqual({ Authorization: "Bearer access-token" });
  });
});

function makeDeps(fetchImpl: typeof fetch) {
  const forceRefreshAccessToken = vi.fn(async () => "refreshed-access-token");
  const deps: ScanMirrorEventsCoreDeps = {
    fetch: fetchImpl,
    getAccessToken: vi.fn(async () => "valid-access-token"),
    forceRefreshAccessToken,
  };
  return { deps, forceRefreshAccessToken };
}

function rawEvent(id: string, overrides: Record<string, unknown> = {}) {
  return { id, status: "confirmed", ...overrides };
}

const MIRROR_PROPS = { extendedProperties: { private: { kichijitsuMirror: "1" } } };

describe("scanMirrorEventsWithRetry", () => {
  it("returns mirror events from a single page", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [rawEvent("mirror-1", MIRROR_PROPS)] }), {
        status: 200,
      }),
    );
    const { deps } = makeDeps(fetchImpl);

    const events = await scanMirrorEventsWithRetry(deps, "primary");

    expect(events.map((e) => e.id)).toEqual(["mirror-1"]);
  });

  /**
   * Google 側の絞り込み (privateExtendedProperty) が実アカウントで確認できていないための
   * 二重チェック (google/scan-mirror-events.ts のコメント参照): 絞り込みが効かずに無関係な
   * 予定が混ざって返ってきても、isMirrorEvent で確実に弾く。
   */
  it("filters out non-mirror events even if Google returns them (defense in depth)", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ items: [rawEvent("plain-1"), rawEvent("mirror-1", MIRROR_PROPS)] }),
        { status: 200 },
      ),
    );
    const { deps } = makeDeps(fetchImpl);

    const events = await scanMirrorEventsWithRetry(deps, "primary");

    expect(events.map((e) => e.id)).toEqual(["mirror-1"]);
  });

  it("follows nextPageToken and combines results across pages", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ items: [rawEvent("mirror-1", MIRROR_PROPS)], nextPageToken: "page-2" }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [rawEvent("mirror-2", MIRROR_PROPS)] }), {
          status: 200,
        }),
      );
    const { deps } = makeDeps(fetchImpl);

    const events = await scanMirrorEventsWithRetry(deps, "primary");

    expect(events.map((e) => e.id)).toEqual(["mirror-1", "mirror-2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondUrl = new URL(fetchImpl.mock.calls[1][0] as string);
    expect(secondUrl.searchParams.get("pageToken")).toBe("page-2");
  });

  it("refreshes the access token once on 401 and retries the same page", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [rawEvent("mirror-1", MIRROR_PROPS)] }), {
          status: 200,
        }),
      );
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl);

    const events = await scanMirrorEventsWithRetry(deps, "primary");

    expect(events.map((e) => e.id)).toEqual(["mirror-1"]);
    expect(forceRefreshAccessToken).toHaveBeenCalledOnce();
  });

  it("propagates non-ok, non-401 responses as GoogleApiError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));
    const { deps } = makeDeps(fetchImpl);

    await expect(scanMirrorEventsWithRetry(deps, "primary")).rejects.toThrow(/500/);
  });

  it("stops pagination after MAX_PAGES and does not throw", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(
        JSON.stringify({ items: [rawEvent("mirror-x", MIRROR_PROPS)], nextPageToken: "next" }),
        { status: 200 },
      ),
    );
    const { deps } = makeDeps(fetchImpl);

    const events = await scanMirrorEventsWithRetry(deps, "primary");

    // MAX_PAGES = 20 (core/scan-mirror-events.ts)。無限ループにならず打ち切ることだけを確認する。
    expect(fetchImpl).toHaveBeenCalledTimes(20);
    expect(events).toHaveLength(20);
  });
});
