import { describe, expect, it, vi } from "vite-plus/test";
import { isValidEventColorRequest, patchEventColorWithRetry } from "../src/core/event-color";
import { GoogleApiError } from "../src/core/errors";
import { patchEventColor } from "../src/google/event-color";

const base = { accountId: "a", calendarId: "primary", eventId: "e1" };

describe("isValidEventColorRequest", () => {
  it("accepts colorId 1..11 and the empty string (clear)", () => {
    for (const colorId of ["1", "6", "11", ""]) {
      expect(isValidEventColorRequest({ ...base, colorId })).toBe(true);
    }
  });
  it("rejects unknown colorId, missing fields and non-strings", () => {
    expect(isValidEventColorRequest({ ...base, colorId: "0" })).toBe(false);
    expect(isValidEventColorRequest({ ...base, colorId: "12" })).toBe(false);
    expect(isValidEventColorRequest({ ...base, colorId: 3 })).toBe(false);
    expect(isValidEventColorRequest({ ...base })).toBe(false);
    expect(isValidEventColorRequest({ accountId: "a", calendarId: "", eventId: "e", colorId: "1" })).toBe(false);
    expect(isValidEventColorRequest(null)).toBe(false);
  });
});

describe("patchEventColor", () => {
  it("PATCHes only colorId with sendUpdates=none (no guest emails)", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await patchEventColor(fetchImpl, "tok", { calendarId: "primary", eventId: "e1", colorId: "6" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/e1?sendUpdates=none");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ colorId: "6" });
  });
  it("sends null to clear the event color when colorId is empty", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await patchEventColor(fetchImpl, "tok", { calendarId: "primary", eventId: "e1", colorId: "" });
    expect(JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string)).toEqual({ colorId: null });
  });
});

describe("patchEventColorWithRetry", () => {
  const deps = (fetchImpl: typeof fetch) => ({
    fetch: fetchImpl,
    getAccessToken: vi.fn().mockResolvedValue("old"),
    forceRefreshAccessToken: vi.fn().mockResolvedValue("new"),
  });
  it("retries once with a refreshed token on 401", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const d = deps(fetchImpl);
    await patchEventColorWithRetry(d, { calendarId: "primary", eventId: "e1", colorId: "2" });
    expect(d.forceRefreshAccessToken).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("throws GoogleApiError on other failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("nope", { status: 403 }));
    await expect(
      patchEventColorWithRetry(deps(fetchImpl), { calendarId: "primary", eventId: "e1", colorId: "2" }),
    ).rejects.toBeInstanceOf(GoogleApiError);
  });
});
