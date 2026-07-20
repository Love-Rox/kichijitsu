import { describe, expect, it } from "vite-plus/test";
import { defaultSearchWindow, filterEventsByQuery } from "../src/core/mcp-search";
import type { GoogleEventDTO } from "@kichijitsu/shared";

function makeEvent(overrides: Partial<GoogleEventDTO> & { id: string }): GoogleEventDTO {
  return { status: "confirmed", ...overrides };
}

describe("defaultSearchWindow", () => {
  it("returns now - 30 days .. now + 90 days as RFC3339", () => {
    const now = Date.UTC(2026, 0, 31); // 2026-01-31T00:00:00Z
    const window = defaultSearchWindow(now);
    expect(window.timeMin).toBe(new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString());
    expect(window.timeMax).toBe(new Date(now + 90 * 24 * 60 * 60 * 1000).toISOString());
  });
});

describe("filterEventsByQuery", () => {
  it("matches on summary", () => {
    const events = [makeEvent({ id: "1", summary: "Team Standup" })];
    expect(filterEventsByQuery(events, "standup")).toEqual(events);
  });

  it("matches on description", () => {
    const events = [makeEvent({ id: "1", description: "Discuss the roadmap" })];
    expect(filterEventsByQuery(events, "roadmap")).toEqual(events);
  });

  it("matches on location", () => {
    const events = [makeEvent({ id: "1", location: "Conference Room B" })];
    expect(filterEventsByQuery(events, "conference")).toEqual(events);
  });

  it("is case-insensitive", () => {
    const events = [makeEvent({ id: "1", summary: "Quarterly Review" })];
    expect(filterEventsByQuery(events, "QUARTERLY")).toEqual(events);
  });

  it("excludes events with no matching field", () => {
    const events = [makeEvent({ id: "1", summary: "Team Standup" })];
    expect(filterEventsByQuery(events, "nonexistent")).toEqual([]);
  });

  it("does not throw for events with all optional fields undefined", () => {
    const events = [makeEvent({ id: "1" })];
    expect(() => filterEventsByQuery(events, "anything")).not.toThrow();
    expect(filterEventsByQuery(events, "anything")).toEqual([]);
  });

  it("returns events unchanged for an empty or whitespace-only query", () => {
    const events = [makeEvent({ id: "1", summary: "Team Standup" }), makeEvent({ id: "2" })];
    expect(filterEventsByQuery(events, "")).toEqual(events);
    expect(filterEventsByQuery(events, "   ")).toEqual(events);
  });
});
