import { describe, expect, it } from "vite-plus/test";
import {
  buildRenewedWatchRow,
  buildWatchRow,
  selectWatchesNeedingRenewal,
  type WatchRow,
} from "../src/core/watch-service";

describe("buildWatchRow", () => {
  it("shapes the D1 row to insert from a successful Google registration", () => {
    const row = buildWatchRow(
      { accountId: "acc-1", calendarId: "primary" },
      "profile-1",
      "channel-abc",
      { resourceId: "resource-xyz", expiration: 1_700_000_000_000 },
      1_600_000_000_000,
    );

    expect(row).toEqual<WatchRow>({
      channel_id: "channel-abc",
      resource_id: "resource-xyz",
      account_id: "acc-1",
      calendar_id: "primary",
      profile_id: "profile-1",
      expiration_ms: 1_700_000_000_000,
      created_at: 1_600_000_000_000,
    });
  });

  it("passes through a null expiration (Google did not return one)", () => {
    const row = buildWatchRow(
      { accountId: "acc-1", calendarId: "primary" },
      "profile-1",
      "channel-abc",
      { resourceId: "resource-xyz", expiration: null },
      1_600_000_000_000,
    );

    expect(row.expiration_ms).toBeNull();
  });
});

describe("buildRenewedWatchRow", () => {
  it("keeps account/calendar/profile from the old row but swaps channel/resource/expiration", () => {
    const oldRow: WatchRow = {
      channel_id: "old-channel",
      resource_id: "old-resource",
      account_id: "acc-1",
      calendar_id: "primary",
      profile_id: "profile-1",
      expiration_ms: 1_000,
      created_at: 500,
    };

    const renewed = buildRenewedWatchRow(
      oldRow,
      "new-channel",
      { resourceId: "new-resource", expiration: 2_000 },
      1_500,
    );

    expect(renewed).toEqual<WatchRow>({
      channel_id: "new-channel",
      resource_id: "new-resource",
      account_id: "acc-1",
      calendar_id: "primary",
      profile_id: "profile-1",
      expiration_ms: 2_000,
      created_at: 1_500,
    });
  });
});

describe("selectWatchesNeedingRenewal", () => {
  function watch(overrides: Partial<WatchRow>): WatchRow {
    return {
      channel_id: "c",
      resource_id: "r",
      account_id: "a",
      calendar_id: "cal",
      profile_id: "p",
      expiration_ms: null,
      created_at: 0,
      ...overrides,
    };
  }

  const NOW = 1_700_000_000_000;
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  it("selects watches expiring within the renewal window", () => {
    const watches = [watch({ channel_id: "expiring-soon", expiration_ms: NOW + ONE_DAY_MS - 1 })];
    expect(selectWatchesNeedingRenewal(watches, NOW).map((w) => w.channel_id)).toEqual([
      "expiring-soon",
    ]);
  });

  it("excludes watches that still have plenty of time left", () => {
    const watches = [watch({ channel_id: "plenty-of-time", expiration_ms: NOW + ONE_DAY_MS + 1 })];
    expect(selectWatchesNeedingRenewal(watches, NOW)).toEqual([]);
  });

  it("excludes watches with a null expiration (unknown expiry, do not touch)", () => {
    const watches = [watch({ channel_id: "no-expiration", expiration_ms: null })];
    expect(selectWatchesNeedingRenewal(watches, NOW)).toEqual([]);
  });

  it("includes watches that have already expired", () => {
    const watches = [watch({ channel_id: "already-expired", expiration_ms: NOW - 1_000 })];
    expect(selectWatchesNeedingRenewal(watches, NOW).map((w) => w.channel_id)).toEqual([
      "already-expired",
    ]);
  });

  it("respects a custom renewal window", () => {
    const watches = [
      watch({ channel_id: "in-two-hours", expiration_ms: NOW + 2 * 60 * 60 * 1000 }),
    ];
    expect(selectWatchesNeedingRenewal(watches, NOW, 60 * 60 * 1000)).toEqual([]);
    expect(
      selectWatchesNeedingRenewal(watches, NOW, 3 * 60 * 60 * 1000).map((w) => w.channel_id),
    ).toEqual(["in-two-hours"]);
  });
});
