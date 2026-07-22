import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Temporal } from "@js-temporal/polyfill";
import type { AllDayOccurrence, Occurrence } from "../model/types";
import { buildEventRsvpRequest, RsvpNotAttendeeError } from "./eventRsvp";

const TZ = "Asia/Tokyo";

function zms(iso: string): number {
  return Temporal.PlainDateTime.from(iso).toZonedDateTime(TZ).epochMilliseconds;
}

function baseOccurrence(overrides: Partial<Occurrence> = {}): Occurrence {
  return {
    id: "g:acc-1:cal-1:evt-1",
    seriesId: null,
    title: "Test Event",
    startMs: zms("2026-07-20T10:00"),
    endMs: zms("2026-07-20T11:00"),
    color: "#3b82f6",
    source: "google",
    accountId: "acc-1",
    calendarId: "cal-1",
    ...overrides,
  };
}

function baseAllDay(overrides: Partial<AllDayOccurrence> = {}): AllDayOccurrence {
  return {
    id: "g:acc-1:cal-1:evt-2",
    seriesId: null,
    title: "All Day Event",
    startDate: "2026-07-20",
    endDate: "2026-07-20",
    color: "#3b82f6",
    source: "google",
    accountId: "acc-1",
    calendarId: "cal-1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildEventRsvpRequest", () => {
  it("単発の google occurrence から EventRsvpRequest を組み立てる", () => {
    const occ = baseOccurrence();
    expect(buildEventRsvpRequest(occ, "accepted")).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      eventId: "evt-1",
      responseStatus: "accepted",
    });
  });

  it("シリーズ由来の occurrence はインスタンス ID を組み立てる", () => {
    const originalStartMs = zms("2026-07-20T10:00");
    const occ = baseOccurrence({
      id: `g:acc-1:cal-1:series-evt:${originalStartMs}`,
      seriesId: "g:acc-1:cal-1:series-evt",
      originalStartMs,
    });
    const req = buildEventRsvpRequest(occ, "declined");
    expect(req?.eventId).toBe("series-evt_20260720T010000Z");
  });

  it("AllDayOccurrence でも組み立てられる", () => {
    const occ = baseAllDay();
    expect(buildEventRsvpRequest(occ, "tentative")).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      eventId: "evt-2",
      responseStatus: "tentative",
    });
  });

  it('source !== "google" なら null', () => {
    const occ = baseOccurrence({ source: "local" });
    expect(buildEventRsvpRequest(occ, "accepted")).toBeNull();
  });

  it("accountId または calendarId が欠けていれば null", () => {
    const occ = baseOccurrence({ calendarId: undefined });
    expect(buildEventRsvpRequest(occ, "accepted")).toBeNull();
  });

  it("id のパースに失敗したら null (throw しない)", () => {
    const occ = baseOccurrence({ id: "not-a-google-id" });
    expect(buildEventRsvpRequest(occ, "accepted")).toBeNull();
  });
});

describe("RsvpNotAttendeeError", () => {
  it("Error のサブクラスで name が 'RsvpNotAttendeeError'", () => {
    const err = new RsvpNotAttendeeError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RsvpNotAttendeeError");
  });
});
