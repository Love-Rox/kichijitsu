import { describe, expect, it, vi } from "vite-plus/test";
import { parseEventGuestState, patchGuestsRaw } from "../src/google/guests-raw";
import { editEventGuestsWithRetry, type GuestEventCoreDeps } from "../src/core/guest-event";
import { GoogleApiError, NotOrganizerError } from "../src/core/errors";
import type { RawAttendee } from "../src/google/rsvp-raw";

const CALENDAR_ID = "primary";
const EVENT_ID = "event-1";

const me: RawAttendee = { email: "me@example.com", self: true, responseStatus: "accepted" };
const other: RawAttendee = { email: "sato@example.com", responseStatus: "tentative" };

/** events.get の応答 (organizer.self で主催者かどうかが決まる) */
function eventResponse(attendees: RawAttendee[], organizerSelf: boolean, status = 200): Response {
  return new Response(JSON.stringify({ attendees, organizer: { self: organizerSelf } }), {
    status,
  });
}

function deps(fetchImpl: typeof fetch, forceRefresh?: () => Promise<string>): GuestEventCoreDeps {
  return {
    fetch: fetchImpl,
    getAccessToken: async () => "access-token",
    forceRefreshAccessToken: forceRefresh ?? (async () => "refreshed-token"),
  };
}

describe("parseEventGuestState", () => {
  it("reads attendees and whether the calendar owner is the organizer", async () => {
    await expect(parseEventGuestState(eventResponse([me, other], true))).resolves.toEqual({
      attendees: [me, other],
      isOrganizer: true,
    });
  });

  it("treats a missing organizer / missing attendees as not-organizer / empty", async () => {
    const response = new Response(JSON.stringify({}), { status: 200 });

    await expect(parseEventGuestState(response)).resolves.toEqual({
      attendees: [],
      isOrganizer: false,
    });
  });

  it("does not treat organizer.self === false as organizer", async () => {
    const state = await parseEventGuestState(eventResponse([me], false));

    expect(state.isOrganizer).toBe(false);
  });
});

describe("patchGuestsRaw", () => {
  it("PATCHes events/{eventId}?sendUpdates=all with the full attendees array", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await patchGuestsRaw(fetchImpl, "access-token", CALENDAR_ID, EVENT_ID, [me, other]);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/event-1?sendUpdates=all",
    );
    const requestInit = init as RequestInit;
    expect(requestInit.method).toBe("PATCH");
    expect((requestInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer access-token",
    );
    // attendees 以外のフィールドは送らない (patch セマンティクスで他項目に触れない)
    expect(JSON.parse(requestInit.body as string)).toEqual({ attendees: [me, other] });
  });

  it("percent-encodes the calendar and event ids", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await patchGuestsRaw(fetchImpl, "t", "a b@example.com", "evt/1", []);

    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/a%20b%40example.com/events/evt%2F1?sendUpdates=all",
    );
  });
});

describe("editEventGuestsWithRetry", () => {
  it("reads the event, then writes back the merged attendees array", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(eventResponse([me, other], true))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await editEventGuestsWithRetry(deps(fetchImpl), {
      calendarId: CALENDAR_ID,
      eventId: EVENT_ID,
      addEmails: ["new@example.com"],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const patchInit = fetchImpl.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(patchInit.body as string)).toEqual({
      attendees: [me, other, { email: "new@example.com" }],
    });
  });

  it("removes a guest while keeping everyone else exactly as Google returned them", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(eventResponse([me, other], true))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await editEventGuestsWithRetry(deps(fetchImpl), {
      calendarId: CALENDAR_ID,
      eventId: EVENT_ID,
      removeEmails: ["sato@example.com"],
    });

    const patchInit = fetchImpl.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(patchInit.body as string)).toEqual({ attendees: [me] });
  });

  it("uses the attendees from events.get, not from the caller (the client list may be truncated)", async () => {
    // クライアントには見えていない参加者が Google 側にいる状況
    const hidden: RawAttendee[] = Array.from({ length: 80 }, (_, i) => ({
      email: `m${i}@example.com`,
    }));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(eventResponse([me, ...hidden], true))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await editEventGuestsWithRetry(deps(fetchImpl), {
      calendarId: CALENDAR_ID,
      eventId: EVENT_ID,
      addEmails: ["new@example.com"],
    });

    const patchInit = fetchImpl.mock.calls[1][1] as RequestInit;
    const sent = JSON.parse(patchInit.body as string) as { attendees: RawAttendee[] };
    expect(sent.attendees).toHaveLength(82);
  });

  it("refuses to write when the calendar owner is not the organizer", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(eventResponse([me, other], false));

    await expect(
      editEventGuestsWithRetry(deps(fetchImpl), {
        calendarId: CALENDAR_ID,
        eventId: EVENT_ID,
        addEmails: ["new@example.com"],
      }),
    ).rejects.toBeInstanceOf(NotOrganizerError);

    // events.get だけで止まり、PATCH は一切送っていない
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("skips the PATCH entirely when nothing would change (no pointless mail to every guest)", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(eventResponse([me, other], true));

    await editEventGuestsWithRetry(deps(fetchImpl), {
      calendarId: CALENDAR_ID,
      eventId: EVENT_ID,
      addEmails: ["sato@example.com"],
      removeEmails: ["ghost@example.com"],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("skips the PATCH when the only requested removal is not removable (self)", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(eventResponse([me, other], true));

    await editEventGuestsWithRetry(deps(fetchImpl), {
      calendarId: CALENDAR_ID,
      eventId: EVENT_ID,
      removeEmails: ["me@example.com"],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refreshes the token once and restarts from the GET on a 401", async () => {
    const forceRefresh = vi.fn(async () => "refreshed-token");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(eventResponse([me, other], true))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await editEventGuestsWithRetry(deps(fetchImpl, forceRefresh), {
      calendarId: CALENDAR_ID,
      eventId: EVENT_ID,
      addEmails: ["new@example.com"],
    });

    expect(forceRefresh).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const retriedGet = fetchImpl.mock.calls[1][1] as RequestInit;
    expect((retriedGet.headers as Record<string, string>).Authorization).toBe(
      "Bearer refreshed-token",
    );
  });

  it("restarts from the GET when the PATCH is the one that 401s", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(eventResponse([me, other], true))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(eventResponse([me, other], true))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await editEventGuestsWithRetry(deps(fetchImpl), {
      calendarId: CALENDAR_ID,
      eventId: EVENT_ID,
      addEmails: ["new@example.com"],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("propagates a second 401 as a GoogleApiError instead of looping", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("nope", { status: 401 }));

    await expect(
      editEventGuestsWithRetry(deps(fetchImpl), {
        calendarId: CALENDAR_ID,
        eventId: EVENT_ID,
        addEmails: ["new@example.com"],
      }),
    ).rejects.toBeInstanceOf(GoogleApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("propagates a failing GET (404) as a GoogleApiError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));

    await expect(
      editEventGuestsWithRetry(deps(fetchImpl), {
        calendarId: CALENDAR_ID,
        eventId: EVENT_ID,
        addEmails: ["new@example.com"],
      }),
    ).rejects.toMatchObject({ name: "GoogleApiError", status: 404 });
  });

  it("propagates a failing PATCH (403 forbiddenForNonOrganizer) as a GoogleApiError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(eventResponse([me, other], true))
      .mockResolvedValueOnce(new Response("forbiddenForNonOrganizer", { status: 403 }));

    await expect(
      editEventGuestsWithRetry(deps(fetchImpl), {
        calendarId: CALENDAR_ID,
        eventId: EVENT_ID,
        addEmails: ["new@example.com"],
      }),
    ).rejects.toMatchObject({ name: "GoogleApiError", status: 403 });
  });
});
