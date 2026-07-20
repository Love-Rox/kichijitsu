import { describe, expect, it } from "vite-plus/test";
import {
  flattenVisibleCalendarTargets,
  resolveDefaultWriteAccountId,
  resolveFallbackTarget,
  resolveReadTargets,
} from "../src/core/mcp-targets";

describe("flattenVisibleCalendarTargets", () => {
  it("returns an empty array for an empty map", () => {
    expect(flattenVisibleCalendarTargets({})).toEqual([]);
  });

  it("flattens a single account with visible calendars", () => {
    expect(flattenVisibleCalendarTargets({ "acc-1": ["cal-a", "cal-b"] })).toEqual([
      { accountId: "acc-1", calendarId: "cal-a" },
      { accountId: "acc-1", calendarId: "cal-b" },
    ]);
  });

  it("flattens multiple accounts", () => {
    expect(
      flattenVisibleCalendarTargets({ "acc-1": ["cal-a"], "acc-2": ["cal-c", "cal-d"] }),
    ).toEqual([
      { accountId: "acc-1", calendarId: "cal-a" },
      { accountId: "acc-2", calendarId: "cal-c" },
      { accountId: "acc-2", calendarId: "cal-d" },
    ]);
  });

  it("contributes nothing for a configured-but-zero-selected account", () => {
    expect(flattenVisibleCalendarTargets({ "acc-1": [] })).toEqual([]);
  });
});

describe("resolveFallbackTarget", () => {
  it("returns null for an empty accounts list", () => {
    expect(resolveFallbackTarget([])).toBeNull();
  });

  it("prefers the owner account's primary calendar", () => {
    const accounts = [
      { id: "acc-1", isOwner: false },
      { id: "acc-2", isOwner: true },
    ];
    expect(resolveFallbackTarget(accounts)).toEqual({ accountId: "acc-2", calendarId: "primary" });
  });

  it("falls back to the first account when no owner flag is set", () => {
    const accounts = [
      { id: "acc-1", isOwner: false },
      { id: "acc-2", isOwner: false },
    ];
    expect(resolveFallbackTarget(accounts)).toEqual({ accountId: "acc-1", calendarId: "primary" });
  });
});

describe("resolveReadTargets", () => {
  it("returns an empty array when both accounts and visibleCalendars are empty", () => {
    expect(resolveReadTargets([], {})).toEqual([]);
  });

  it("uses the flattened visible calendars when at least one pair exists", () => {
    const accounts = [{ id: "acc-1", isOwner: true }];
    expect(resolveReadTargets(accounts, { "acc-1": ["cal-a"] })).toEqual([
      { accountId: "acc-1", calendarId: "cal-a" },
    ]);
  });

  it("falls back to the owner's primary calendar when nothing is configured", () => {
    const accounts = [
      { id: "acc-1", isOwner: false },
      { id: "acc-2", isOwner: true },
    ];
    expect(resolveReadTargets(accounts, {})).toEqual([
      { accountId: "acc-2", calendarId: "primary" },
    ]);
  });

  it("falls back when configured accounts all selected zero calendars", () => {
    const accounts = [{ id: "acc-1", isOwner: true }];
    expect(resolveReadTargets(accounts, { "acc-1": [] })).toEqual([
      { accountId: "acc-1", calendarId: "primary" },
    ]);
  });

  it("handles multiple accounts with a mix of configured and unconfigured", () => {
    const accounts = [
      { id: "acc-1", isOwner: true },
      { id: "acc-2", isOwner: false },
    ];
    expect(resolveReadTargets(accounts, { "acc-1": ["cal-a"] })).toEqual([
      { accountId: "acc-1", calendarId: "cal-a" },
    ]);
  });
});

describe("resolveDefaultWriteAccountId", () => {
  it("returns null for an empty accounts list", () => {
    expect(resolveDefaultWriteAccountId([])).toBeNull();
  });

  it("prefers the owner account", () => {
    const accounts = [
      { id: "acc-1", isOwner: false },
      { id: "acc-2", isOwner: true },
    ];
    expect(resolveDefaultWriteAccountId(accounts)).toBe("acc-2");
  });

  it("falls back to the first account when no owner flag is set", () => {
    const accounts = [
      { id: "acc-1", isOwner: false },
      { id: "acc-2", isOwner: false },
    ];
    expect(resolveDefaultWriteAccountId(accounts)).toBe("acc-1");
  });
});
