import { describe, expect, it, vi } from "vite-plus/test";
import {
  getEventRaw,
  parseEventAttendees,
  patchAttendeesRaw,
  type RawAttendee,
} from "../src/google/rsvp-raw";
import { rsvpEventWithRetry, type RsvpEventCoreDeps } from "../src/core/rsvp-event";
import { NotAnAttendeeError } from "../src/core/errors";

const CALENDAR_ID = "primary";
const EVENT_ID = "event-1";

describe("getEventRaw", () => {
  it("GETs events/{eventId} with a bearer auth header", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    await getEventRaw(fetchImpl, "access-token", CALENDAR_ID, EVENT_ID);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/event-1");
    const requestInit = init as RequestInit;
    expect((requestInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer access-token",
    );
  });
});

describe("parseEventAttendees", () => {
  it("returns the attendees array from the response body", async () => {
    const attendees: RawAttendee[] = [
      { email: "me@example.com", self: true, responseStatus: "needsAction" },
    ];
    const response = new Response(JSON.stringify({ attendees }), { status: 200 });

    await expect(parseEventAttendees(response)).resolves.toEqual(attendees);
  });

  it("returns an empty array when the event has no attendees", async () => {
    const response = new Response(JSON.stringify({}), { status: 200 });

    await expect(parseEventAttendees(response)).resolves.toEqual([]);
  });
});

describe("patchAttendeesRaw", () => {
  it("PATCHes events/{eventId}?sendUpdates=all with the full attendees array", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const attendees: RawAttendee[] = [
      { email: "me@example.com", self: true, responseStatus: "accepted" },
      { email: "other@example.com", self: false, responseStatus: "needsAction" },
    ];

    await patchAttendeesRaw(fetchImpl, "access-token", CALENDAR_ID, EVENT_ID, attendees);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/event-1?sendUpdates=all",
    );
    const requestInit = init as RequestInit;
    expect(requestInit.method).toBe("PATCH");
    expect(JSON.parse(requestInit.body as string)).toEqual({ attendees });
  });
});

function eventResponse(attendees?: RawAttendee[]): Response {
  return new Response(JSON.stringify(attendees ? { attendees } : {}), { status: 200 });
}

function makeDeps(fetchImpl: typeof fetch) {
  const forceRefreshAccessToken = vi.fn(async () => "refreshed-access-token");
  const deps: RsvpEventCoreDeps = {
    fetch: fetchImpl,
    getAccessToken: vi.fn(async () => "valid-access-token"),
    forceRefreshAccessToken,
  };
  return { deps, forceRefreshAccessToken };
}

const PARAMS = { calendarId: CALENDAR_ID, eventId: EVENT_ID, responseStatus: "accepted" as const };

describe("rsvpEventWithRetry", () => {
  it("reads attendees, flips only the self entry's responseStatus, and PATCHes the full array back", async () => {
    const attendees: RawAttendee[] = [
      { email: "other@example.com", self: false, responseStatus: "accepted", displayName: "Other" },
      { email: "me@example.com", self: true, responseStatus: "needsAction" },
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(eventResponse(attendees))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const { deps } = makeDeps(fetchImpl);

    await expect(rsvpEventWithRetry(deps, PARAMS)).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // 1st call = events.get, 2nd = events.patch (sendUpdates=all)
    const patchCall = fetchImpl.mock.calls[1];
    expect(patchCall[0]).toContain("sendUpdates=all");
    const patchedBody = JSON.parse((patchCall[1] as RequestInit).body as string);
    expect(patchedBody.attendees).toEqual([
      // other attendee (including fields kichijitsu never reads, like displayName)
      // is preserved untouched — only the self entry changes.
      { email: "other@example.com", self: false, responseStatus: "accepted", displayName: "Other" },
      { email: "me@example.com", self: true, responseStatus: "accepted" },
    ]);
  });

  it("throws NotAnAttendeeError when no attendee has self:true (not invited / no attendees)", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(eventResponse([]));
    const { deps } = makeDeps(fetchImpl);

    await expect(rsvpEventWithRetry(deps, PARAMS)).rejects.toBeInstanceOf(NotAnAttendeeError);
    // No PATCH should be attempted once we know there's nothing to update.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws NotAnAttendeeError when the event has no attendees field at all", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(eventResponse(undefined));
    const { deps } = makeDeps(fetchImpl);

    await expect(rsvpEventWithRetry(deps, PARAMS)).rejects.toBeInstanceOf(NotAnAttendeeError);
  });

  it("propagates a GET 404 as GoogleApiError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));
    const { deps } = makeDeps(fetchImpl);

    await expect(rsvpEventWithRetry(deps, PARAMS)).rejects.toThrow(/404/);
  });

  it("propagates a PATCH 412 (precondition failed) as GoogleApiError", async () => {
    const attendees: RawAttendee[] = [
      { email: "me@example.com", self: true, responseStatus: "declined" },
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(eventResponse(attendees))
      .mockResolvedValueOnce(new Response("precondition failed", { status: 412 }));
    const { deps } = makeDeps(fetchImpl);

    await expect(rsvpEventWithRetry(deps, PARAMS)).rejects.toThrow(/412/);
  });

  it("refreshes the access token once and redoes the whole get+patch sequence on a 401 from events.get", async () => {
    const attendees: RawAttendee[] = [
      { email: "me@example.com", self: true, responseStatus: "needsAction" },
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(eventResponse(attendees))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl);

    await expect(rsvpEventWithRetry(deps, PARAMS)).resolves.toBeUndefined();

    expect(forceRefreshAccessToken).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const retriedGetAuth = (fetchImpl.mock.calls[1][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(retriedGetAuth.Authorization).toBe("Bearer refreshed-access-token");
  });

  it("refreshes the access token once and redoes the whole get+patch sequence on a 401 from events.patch", async () => {
    const attendees: RawAttendee[] = [
      { email: "me@example.com", self: true, responseStatus: "needsAction" },
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(eventResponse(attendees))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(eventResponse(attendees))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl);

    await expect(rsvpEventWithRetry(deps, PARAMS)).resolves.toBeUndefined();

    expect(forceRefreshAccessToken).toHaveBeenCalledOnce();
    // get, patch(401), get again, patch again = 4 calls total (whole sequence redone once).
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("gives up after a second 401 (only retries once)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl);

    await expect(rsvpEventWithRetry(deps, PARAMS)).rejects.toThrow(/401/);
    expect(forceRefreshAccessToken).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
