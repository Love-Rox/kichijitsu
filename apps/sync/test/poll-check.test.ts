import { describe, expect, it, vi } from "vite-plus/test";
import { buildPollCheckUrl, hasUpdatesSince } from "../src/google/poll-check";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("buildPollCheckUrl", () => {
  it("builds a URL that filters by updatedMin without ever setting orderBy", () => {
    const url = new URL(buildPollCheckUrl("primary", "2026-07-01T00:00:00.000Z"));

    expect(url.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(url.searchParams.get("updatedMin")).toBe("2026-07-01T00:00:00.000Z");
    expect(url.searchParams.get("maxResults")).toBe("1");
    expect(url.searchParams.get("showDeleted")).toBe("true");
    expect(url.searchParams.get("fields")).toBe("items(id)");
    expect(url.searchParams.get("orderBy")).toBeNull();
    // syncToken を消費しないチェックなので、syncToken/pageToken 系のパラメータは一切付けない
    expect(url.searchParams.get("syncToken")).toBeNull();
  });

  it("encodes calendar ids that need escaping (e.g. an email-shaped calendarId)", () => {
    const url = new URL(buildPollCheckUrl("someone@example.com", "2026-07-01T00:00:00.000Z"));
    expect(url.pathname).toBe("/calendar/v3/calendars/someone%40example.com/events");
  });
});

describe("hasUpdatesSince", () => {
  it("returns true when Google reports at least one event updated since the watermark", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { items: [{ id: "evt-1" }] }));

    const result = await hasUpdatesSince(
      fetchImpl,
      "access-token",
      "primary",
      "2026-07-01T00:00:00.000Z",
    );

    expect(result).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("updatedMin=2026-07-01");
    expect((init as RequestInit).headers).toEqual({ Authorization: "Bearer access-token" });
  });

  it("returns false when there are no items (nothing changed)", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(200, { items: [] }));

    const result = await hasUpdatesSince(
      fetchImpl,
      "access-token",
      "primary",
      "2026-07-01T00:00:00.000Z",
    );

    expect(result).toBe(false);
  });

  it("returns false when items is entirely absent from the response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(200, {}));

    const result = await hasUpdatesSince(
      fetchImpl,
      "access-token",
      "primary",
      "2026-07-01T00:00:00.000Z",
    );

    expect(result).toBe(false);
  });

  it("throws GoogleApiError (does not swallow) on a non-ok response", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }));

    await expect(
      hasUpdatesSince(fetchImpl, "access-token", "primary", "2026-07-01T00:00:00.000Z"),
    ).rejects.toThrow(/429/);
  });
});
