import { describe, expect, it, vi } from "vite-plus/test";
import {
  addEventMeetWithRetry,
  conferenceUrlFrom,
  isValidEventMeetRequest,
} from "../src/core/event-meet";
import { GoogleApiError } from "../src/core/errors";
import { addEventMeet } from "../src/google/event-meet";

const base = { accountId: "a", calendarId: "primary", eventId: "e1" };

describe("isValidEventMeetRequest", () => {
  it("accepts the three required ids", () => {
    expect(isValidEventMeetRequest(base)).toBe(true);
  });
  it("rejects missing/empty fields and non-objects", () => {
    expect(isValidEventMeetRequest({ ...base, eventId: "" })).toBe(false);
    expect(isValidEventMeetRequest({ accountId: "a", calendarId: "primary" })).toBe(false);
    expect(isValidEventMeetRequest(null)).toBe(false);
    expect(isValidEventMeetRequest("x")).toBe(false);
  });
});

describe("addEventMeet", () => {
  it("PATCHes only conferenceData.createRequest, with conferenceDataVersion=1 and an explicit sendUpdates", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await addEventMeet(fetchImpl, "tok", {
      calendarId: "primary",
      eventId: "e1",
      sendUpdates: "externalOnly",
      requestId: "req-1",
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/e1?conferenceDataVersion=1&sendUpdates=externalOnly",
    );
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      conferenceData: {
        createRequest: { requestId: "req-1", conferenceSolutionKey: { type: "hangoutsMeet" } },
      },
    });
  });
});

describe("conferenceUrlFrom", () => {
  it("prefers hangoutLink", () => {
    expect(conferenceUrlFrom({ hangoutLink: "https://meet.google.com/abc-defg-hij" })).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
  });
  it("falls back to the video entry point", () => {
    expect(
      conferenceUrlFrom({
        conferenceData: {
          entryPoints: [
            { entryPointType: "phone", uri: "tel:+1" },
            { entryPointType: "video", uri: "https://meet.google.com/xyz" },
          ],
        },
      }),
    ).toBe("https://meet.google.com/xyz");
  });
  it("returns undefined while the conference is still pending", () => {
    expect(conferenceUrlFrom({ conferenceData: { createRequest: { status: { statusCode: "pending" } } } })).toBeUndefined();
    expect(conferenceUrlFrom(undefined)).toBeUndefined();
  });
});

describe("addEventMeetWithRetry", () => {
  const deps = (fetchImpl: typeof fetch) => ({
    fetch: fetchImpl,
    getAccessToken: vi.fn().mockResolvedValue("old"),
    forceRefreshAccessToken: vi.fn().mockResolvedValue("new"),
  });
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it("returns the meeting URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(ok({ hangoutLink: "https://meet.google.com/a" }));
    const r = await addEventMeetWithRetry(deps(fetchImpl), { calendarId: "primary", eventId: "e1" });
    expect(r).toEqual({ conferenceUrl: "https://meet.google.com/a" });
  });

  it("retries once on 401 with a refreshed token, reusing the same requestId (no duplicate meetings)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(ok({ hangoutLink: "https://meet.google.com/a" }));
    const d = deps(fetchImpl);
    await addEventMeetWithRetry(d, { calendarId: "primary", eventId: "e1" }, () => "fixed-id");
    expect(d.forceRefreshAccessToken).toHaveBeenCalledOnce();
    const ids = fetchImpl.mock.calls.map(
      ([, init]) => JSON.parse((init as RequestInit).body as string).conferenceData.createRequest.requestId,
    );
    expect(ids).toEqual(["fixed-id", "fixed-id"]);
  });

  it("treats a failed conference creation (200 + failure status) as an error", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ conferenceData: { createRequest: { status: { statusCode: "failure" } } } }));
    await expect(
      addEventMeetWithRetry(deps(fetchImpl), { calendarId: "primary", eventId: "e1" }),
    ).rejects.toBeInstanceOf(GoogleApiError);
  });

  it("throws GoogleApiError on other failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("nope", { status: 403 }));
    await expect(
      addEventMeetWithRetry(deps(fetchImpl), { calendarId: "primary", eventId: "e1" }),
    ).rejects.toBeInstanceOf(GoogleApiError);
  });
});
