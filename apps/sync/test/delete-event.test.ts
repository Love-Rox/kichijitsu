import { describe, expect, it, vi } from "vite-plus/test";
import { deleteEvent } from "../src/google/delete-event";
import {
  deleteEventWithRetry,
  isValidEventDeleteRequest,
  type DeleteEventCoreDeps,
} from "../src/core/delete-event";

const PARAMS = {
  calendarId: "primary",
  eventId: "event-1",
  sendUpdates: "externalOnly" as const,
};

describe("deleteEvent", () => {
  it("DELETEs events/{eventId} with a bearer auth header", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await deleteEvent(fetchImpl, "access-token", PARAMS);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/event-1?sendUpdates=externalOnly",
    );
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
      sendUpdates: "externalOnly",
    });

    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/a%2Fb%40example.com/events/event%20id%20with%20spaces?sendUpdates=externalOnly",
    );
  });

  // sendUpdates を必ず載せる (2026-07-31)。省略時の既定が未文書なので、付け忘れた
  // リクエストが1本でも出ると「キャンセルメールが飛ぶか分からない削除」になる
  it("always puts sendUpdates on the query string", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));

    await deleteEvent(fetchImpl, "access-token", { ...PARAMS, sendUpdates: "all" });
    expect(fetchImpl.mock.calls[0][0] as string).toContain("?sendUpdates=all");

    await deleteEvent(fetchImpl, "access-token", { ...PARAMS, sendUpdates: "externalOnly" });
    expect(fetchImpl.mock.calls[1][0] as string).toContain("?sendUpdates=externalOnly");
  });
});

describe("isValidEventDeleteRequest", () => {
  const valid = { accountId: "acc-1", calendarId: "cal-1", eventId: "evt-1" };

  it("3つの id が揃っていれば通る (sendUpdates は無くてもよい = 旧クライアント)", () => {
    expect(isValidEventDeleteRequest(valid)).toBe(true);
  });

  it("id が欠けている・空文字・オブジェクトでないものは弾く", () => {
    expect(isValidEventDeleteRequest(null)).toBe(false);
    expect(isValidEventDeleteRequest("nope")).toBe(false);
    expect(isValidEventDeleteRequest({})).toBe(false);
    expect(isValidEventDeleteRequest({ ...valid, accountId: "" })).toBe(false);
    expect(isValidEventDeleteRequest({ ...valid, calendarId: undefined })).toBe(false);
    expect(isValidEventDeleteRequest({ ...valid, eventId: 42 })).toBe(false);
  });

  it("sendUpdates は all / externalOnly のみ通す", () => {
    expect(isValidEventDeleteRequest({ ...valid, sendUpdates: "all" })).toBe(true);
    expect(isValidEventDeleteRequest({ ...valid, sendUpdates: "externalOnly" })).toBe(true);
  });

  it("sendUpdates: 'none' は弾く (外部ゲストのカレンダーに取り消しが届かなくなる)", () => {
    expect(isValidEventDeleteRequest({ ...valid, sendUpdates: "none" })).toBe(false);
    expect(isValidEventDeleteRequest({ ...valid, sendUpdates: "" })).toBe(false);
    expect(isValidEventDeleteRequest({ ...valid, sendUpdates: true })).toBe(false);
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
