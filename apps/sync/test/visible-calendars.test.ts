import { describe, expect, it } from "vite-plus/test";
import {
  aggregateVisibleCalendars,
  buildCalendarPrefsRow,
  buildVisibleCalendarRows,
  isValidVisibleCalendarsRequest,
} from "../src/core/visible-calendars";

describe("aggregateVisibleCalendars", () => {
  it("includes an empty array for a configured account with zero selected calendars", () => {
    expect(aggregateVisibleCalendars(["acc-1"], [])).toEqual({ "acc-1": [] });
  });

  it("includes the selected calendar ids for a configured account", () => {
    const rows = [
      { account_id: "acc-1", calendar_id: "cal-a" },
      { account_id: "acc-1", calendar_id: "cal-b" },
    ];
    expect(aggregateVisibleCalendars(["acc-1"], rows)).toEqual({ "acc-1": ["cal-a", "cal-b"] });
  });

  it("omits the key entirely for an account that is not configured", () => {
    // account_calendar_prefs に行が無い = 未設定。visibleCalendars にキー自体を含めない
    // (クライアントが primary をデフォルト選択する余地を残すため、空配列とは区別する)。
    expect(aggregateVisibleCalendars([], [])).toEqual({});
  });

  it("ignores visible rows for accounts that are not in the configured set", () => {
    // レース等で configured でないアカウントの選択行が混じっていても無視する。
    const rows = [{ account_id: "acc-unconfigured", calendar_id: "cal-a" }];
    expect(aggregateVisibleCalendars(["acc-1"], rows)).toEqual({ "acc-1": [] });
  });

  it("aggregates multiple configured accounts independently", () => {
    const rows = [
      { account_id: "acc-1", calendar_id: "cal-a" },
      { account_id: "acc-2", calendar_id: "cal-c" },
    ];
    expect(aggregateVisibleCalendars(["acc-1", "acc-2", "acc-3"], rows)).toEqual({
      "acc-1": ["cal-a"],
      "acc-2": ["cal-c"],
      "acc-3": [],
    });
  });
});

describe("isValidVisibleCalendarsRequest", () => {
  it("accepts a valid request with a non-empty calendarIds array", () => {
    expect(
      isValidVisibleCalendarsRequest({ accountId: "acc-1", calendarIds: ["cal-a", "cal-b"] }),
    ).toBe(true);
  });

  it('accepts a valid request with an empty calendarIds array (explicit "all cleared" intent)', () => {
    expect(isValidVisibleCalendarsRequest({ accountId: "acc-1", calendarIds: [] })).toBe(true);
  });

  it("rejects a missing accountId", () => {
    expect(isValidVisibleCalendarsRequest({ calendarIds: [] })).toBe(false);
  });

  it("rejects an empty-string accountId", () => {
    expect(isValidVisibleCalendarsRequest({ accountId: "", calendarIds: [] })).toBe(false);
  });

  it("rejects a non-array calendarIds", () => {
    expect(isValidVisibleCalendarsRequest({ accountId: "acc-1", calendarIds: "cal-a" })).toBe(
      false,
    );
  });

  it("rejects calendarIds containing non-string entries", () => {
    expect(isValidVisibleCalendarsRequest({ accountId: "acc-1", calendarIds: ["cal-a", 42] })).toBe(
      false,
    );
  });

  it("rejects null and non-object bodies", () => {
    expect(isValidVisibleCalendarsRequest(null)).toBe(false);
    expect(isValidVisibleCalendarsRequest("not-an-object")).toBe(false);
    expect(isValidVisibleCalendarsRequest(undefined)).toBe(false);
  });
});

describe("buildVisibleCalendarRows", () => {
  it("builds one row per calendar id with the given account and timestamp", () => {
    expect(buildVisibleCalendarRows("acc-1", ["cal-a", "cal-b"], 1000)).toEqual([
      { account_id: "acc-1", calendar_id: "cal-a", created_at: 1000 },
      { account_id: "acc-1", calendar_id: "cal-b", created_at: 1000 },
    ]);
  });

  it("returns an empty array for an empty selection", () => {
    expect(buildVisibleCalendarRows("acc-1", [], 1000)).toEqual([]);
  });

  it("de-duplicates repeated calendar ids to match the (account_id, calendar_id) primary key", () => {
    expect(buildVisibleCalendarRows("acc-1", ["cal-a", "cal-a", "cal-b"], 1000)).toEqual([
      { account_id: "acc-1", calendar_id: "cal-a", created_at: 1000 },
      { account_id: "acc-1", calendar_id: "cal-b", created_at: 1000 },
    ]);
  });
});

describe("buildCalendarPrefsRow", () => {
  it("always sets configured=1", () => {
    expect(buildCalendarPrefsRow("acc-1", 1000)).toEqual({
      account_id: "acc-1",
      configured: 1,
      updated_at: 1000,
    });
  });
});
