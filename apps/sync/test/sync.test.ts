import { describe, expect, it, vi } from "vite-plus/test";
import { syncCalendar, type SyncCoreDeps } from "../src/core/sync";

const CALENDAR_ID = "primary";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeEvent(id: string) {
  return { id, status: "confirmed" as const, summary: `Event ${id}` };
}

interface DepsOverrides {
  syncToken?: string | null;
  accessToken?: string;
}

function makeDeps(fetchImpl: typeof fetch, overrides: DepsOverrides = {}) {
  const saveSyncToken = vi.fn(async () => {});
  const forceRefreshAccessToken = vi.fn(async () => "refreshed-access-token");
  const deps: SyncCoreDeps = {
    fetch: fetchImpl,
    getAccessToken: vi.fn(async () => overrides.accessToken ?? "valid-access-token"),
    forceRefreshAccessToken,
    getSyncToken: vi.fn(async () => overrides.syncToken ?? null),
    saveSyncToken,
  };
  return { deps, saveSyncToken, forceRefreshAccessToken };
}

describe("syncCalendar", () => {
  it("combines paginated results for an incremental sync", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(200, { items: [makeEvent("e1")], nextPageToken: "page-2" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { items: [makeEvent("e2")], nextSyncToken: "new-sync-token" }),
      );
    const { deps, saveSyncToken } = makeDeps(fetchImpl, { syncToken: "existing-sync-token" });

    const result = await syncCalendar(deps, CALENDAR_ID);

    expect(result.isFullSync).toBe(false);
    expect(result.events.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const firstUrl = new URL(fetchImpl.mock.calls[0][0] as string);
    expect(firstUrl.searchParams.get("syncToken")).toBe("existing-sync-token");
    expect(firstUrl.searchParams.get("pageToken")).toBeNull();
    expect(firstUrl.searchParams.get("singleEvents")).toBe("false");

    const secondUrl = new URL(fetchImpl.mock.calls[1][0] as string);
    expect(secondUrl.searchParams.get("pageToken")).toBe("page-2");
    // 継続ページでは syncToken を送り直さない
    expect(secondUrl.searchParams.get("syncToken")).toBeNull();

    expect(saveSyncToken).toHaveBeenCalledOnce();
    expect(saveSyncToken).toHaveBeenCalledWith(CALENDAR_ID, "new-sync-token");
  });

  it("falls back to a full sync and saves a new syncToken when the old one is gone (410)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 410 }))
      .mockResolvedValueOnce(
        jsonResponse(200, { items: [makeEvent("e1")], nextSyncToken: "fresh-sync-token" }),
      );
    const { deps, saveSyncToken } = makeDeps(fetchImpl, { syncToken: "expired-sync-token" });

    const result = await syncCalendar(deps, CALENDAR_ID);

    expect(result.isFullSync).toBe(true);
    expect(result.events.map((e) => e.id)).toEqual(["e1"]);

    // 410 を検知した時点で一度 null 保存し、フォールバック後の全同期でまた保存する
    expect(saveSyncToken).toHaveBeenNthCalledWith(1, CALENDAR_ID, null);
    expect(saveSyncToken).toHaveBeenNthCalledWith(2, CALENDAR_ID, "fresh-sync-token");

    const fallbackUrl = new URL(fetchImpl.mock.calls[1][0] as string);
    expect(fallbackUrl.searchParams.get("syncToken")).toBeNull();
    expect(fallbackUrl.searchParams.get("pageToken")).toBeNull();
  });

  it("marks isFullSync: true when there is no stored syncToken", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(200, { items: [makeEvent("e1")], nextSyncToken: "brand-new-token" }),
      );
    const { deps } = makeDeps(fetchImpl, { syncToken: null });

    const result = await syncCalendar(deps, CALENDAR_ID);

    expect(result.isFullSync).toBe(true);
    const url = new URL(fetchImpl.mock.calls[0][0] as string);
    expect(url.searchParams.get("syncToken")).toBeNull();
    expect(url.searchParams.get("timeMin")).toBeNull();
    expect(url.searchParams.get("timeMax")).toBeNull();
  });

  it("refreshes the access token once on 401 and retries the same page", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        jsonResponse(200, { items: [makeEvent("e1")], nextSyncToken: "token" }),
      );
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl, {
      syncToken: null,
      accessToken: "stale-access-token",
    });

    const result = await syncCalendar(deps, CALENDAR_ID);

    expect(forceRefreshAccessToken).toHaveBeenCalledOnce();
    expect(result.events.map((e) => e.id)).toEqual(["e1"]);

    const firstAuth = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(firstAuth.Authorization).toBe("Bearer stale-access-token");
    const secondAuth = (fetchImpl.mock.calls[1][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(secondAuth.Authorization).toBe("Bearer refreshed-access-token");
  });

  it("propagates non-410/401 errors (e.g. 429/5xx) instead of swallowing them", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    const { deps } = makeDeps(fetchImpl, { syncToken: null });

    await expect(syncCalendar(deps, CALENDAR_ID)).rejects.toThrow(/429/);
  });
});
