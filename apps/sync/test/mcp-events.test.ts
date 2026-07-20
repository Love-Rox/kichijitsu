import { describe, expect, it } from "vite-plus/test";
import { dedupeEventViews, toBusyIntervals, toMcpEventView } from "../src/core/mcp-events";
import type { GoogleEventDTO } from "@kichijitsu/shared";
import type { McpEventView } from "../src/core/mcp-events";

function makeEvent(overrides: Partial<GoogleEventDTO> & { id: string }): GoogleEventDTO {
  return { status: "confirmed", ...overrides };
}

describe("toMcpEventView", () => {
  it("shapes a GoogleEventDTO into the compact view, dropping internal-only fields", () => {
    const event = makeEvent({
      id: "evt-1",
      summary: "Sync",
      start: { dateTime: "2026-01-01T09:00:00Z" },
      end: { dateTime: "2026-01-01T10:00:00Z" },
      location: "Room A",
      htmlLink: "https://calendar.google.com/evt-1",
      description: "internal notes",
      recurrence: ["RRULE:FREQ=WEEKLY"],
      extendedProperties: { private: { foo: "bar" } },
    });
    const view = toMcpEventView("acc-1", "cal-1", event);
    expect(view).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      id: "evt-1",
      summary: "Sync",
      start: { dateTime: "2026-01-01T09:00:00Z" },
      end: { dateTime: "2026-01-01T10:00:00Z" },
      location: "Room A",
      htmlLink: "https://calendar.google.com/evt-1",
    });
    expect(view).not.toHaveProperty("description");
    expect(view).not.toHaveProperty("recurrence");
    expect(view).not.toHaveProperty("extendedProperties");
  });

  it("handles events with no optional fields", () => {
    const event = makeEvent({ id: "evt-2" });
    expect(toMcpEventView("acc-1", "cal-1", event)).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      id: "evt-2",
      summary: undefined,
      start: undefined,
      end: undefined,
      location: undefined,
      htmlLink: undefined,
    });
  });
});

describe("toBusyIntervals", () => {
  it("includes normal timed events", () => {
    const events = [
      makeEvent({
        id: "evt-1",
        start: { dateTime: "2026-01-01T09:00:00Z" },
        end: { dateTime: "2026-01-01T10:00:00Z" },
      }),
    ];
    expect(toBusyIntervals(events)).toEqual([
      { startMs: Date.parse("2026-01-01T09:00:00Z"), endMs: Date.parse("2026-01-01T10:00:00Z") },
    ]);
  });

  it("excludes cancelled events", () => {
    const events = [
      makeEvent({
        id: "evt-1",
        status: "cancelled",
        start: { dateTime: "2026-01-01T09:00:00Z" },
        end: { dateTime: "2026-01-01T10:00:00Z" },
      }),
    ];
    expect(toBusyIntervals(events)).toEqual([]);
  });

  it("excludes all-day (date-only) events", () => {
    const events = [
      makeEvent({
        id: "evt-1",
        start: { date: "2026-01-01" },
        end: { date: "2026-01-02" },
      }),
    ];
    expect(toBusyIntervals(events)).toEqual([]);
  });

  it("excludes events with unparseable dateTime", () => {
    const events = [
      makeEvent({
        id: "evt-1",
        start: { dateTime: "not-a-date" },
        end: { dateTime: "2026-01-01T10:00:00Z" },
      }),
    ];
    expect(toBusyIntervals(events)).toEqual([]);
  });

  it("excludes events missing start or end entirely", () => {
    const events = [makeEvent({ id: "evt-1", end: { dateTime: "2026-01-01T10:00:00Z" } })];
    expect(toBusyIntervals(events)).toEqual([]);
  });
});

function makeView(accountId: string, calendarId: string, id: string): McpEventView {
  return { accountId, calendarId, id };
}

describe("dedupeEventViews", () => {
  it("passes through unchanged when there are no duplicates", () => {
    const events = [makeView("acc-1", "cal-a", "evt-1"), makeView("acc-1", "cal-a", "evt-2")];
    expect(dedupeEventViews(events)).toEqual(events);
  });

  it("removes an exact calendarId+id duplicate, keeping the first occurrence", () => {
    const first = makeView("acc-1", "cal-a", "evt-1");
    // 同じイベントが別アカウント経由で見えているケース (dedupeReadTargetsByCalendar の
    // 対象側 dedupe をすり抜けた場合の結果側の安全網)。
    const duplicate = makeView("acc-2", "cal-a", "evt-1");
    expect(dedupeEventViews([first, duplicate])).toEqual([first]);
  });

  it("does not dedupe the same id across different calendarIds", () => {
    const events = [makeView("acc-1", "cal-a", "evt-1"), makeView("acc-2", "cal-b", "evt-1")];
    expect(dedupeEventViews(events)).toEqual(events);
  });

  it("preserves first-occurrence order of surviving events", () => {
    const events = [
      makeView("acc-1", "cal-a", "evt-3"),
      makeView("acc-1", "cal-a", "evt-1"),
      makeView("acc-2", "cal-a", "evt-3"), // duplicate of the first (same calendarId+id)
      makeView("acc-1", "cal-a", "evt-2"),
    ];
    expect(dedupeEventViews(events)).toEqual([
      makeView("acc-1", "cal-a", "evt-3"),
      makeView("acc-1", "cal-a", "evt-1"),
      makeView("acc-1", "cal-a", "evt-2"),
    ]);
  });
});
