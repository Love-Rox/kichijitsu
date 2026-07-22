import { describe, expect, it } from "vite-plus/test";
import { Temporal } from "@js-temporal/polyfill";
import type { AllDayOccurrence, Occurrence } from "../model/types";
import type { AllDayOccurrenceGroup, OccurrenceGroup } from "./groupDuplicates";
import {
  allDayOooRailItems,
  isOutOfOffice,
  splitOutOfOfficeAllDayGroups,
  splitOutOfOfficeGroups,
  timedOooRailItems,
} from "./oooRail";

function occ(overrides: Partial<Occurrence> = {}): Occurrence {
  return {
    id: "g:acc-1:cal-1:evt-1",
    seriesId: null,
    title: "Test Event",
    startMs: 1_000,
    endMs: 2_000,
    color: "#3b82f6",
    source: "google",
    accountId: "acc-1",
    calendarId: "cal-1",
    ...overrides,
  };
}

function allDayOcc(overrides: Partial<AllDayOccurrence> = {}): AllDayOccurrence {
  return {
    id: "g:acc-1:cal-1:allday-1",
    seriesId: null,
    title: "休暇中",
    startDate: "2026-07-20",
    endDate: "2026-07-20",
    color: "#3b82f6",
    source: "google",
    accountId: "acc-1",
    calendarId: "cal-1",
    ...overrides,
  };
}

function group(primary: Occurrence): OccurrenceGroup {
  return { primary, members: [primary] };
}

function allDayGroup(primary: AllDayOccurrence): AllDayOccurrenceGroup {
  return { primary, members: [primary] };
}

describe("isOutOfOffice", () => {
  it("isOutOfOffice: true のときだけ true を返す", () => {
    expect(isOutOfOffice({ isOutOfOffice: true })).toBe(true);
    expect(isOutOfOffice({ isOutOfOffice: false })).toBe(false);
    expect(isOutOfOffice({})).toBe(false);
  });
});

describe("splitOutOfOfficeGroups", () => {
  it("不在の group を cardGroups から除外し、oooGroups へ振り分ける(packColumns 入力からの除外)", () => {
    const normal = group(occ({ id: "normal-1" }));
    const ooo = group(occ({ id: "ooo-1", isOutOfOffice: true }));

    const { cardGroups, oooGroups } = splitOutOfOfficeGroups([normal, ooo]);

    expect(cardGroups).toEqual([normal]);
    expect(oooGroups).toEqual([ooo]);
  });

  it("不在が無ければ oooGroups は空、cardGroups は全件そのまま", () => {
    const a = group(occ({ id: "a" }));
    const b = group(occ({ id: "b" }));

    const { cardGroups, oooGroups } = splitOutOfOfficeGroups([a, b]);

    expect(cardGroups).toEqual([a, b]);
    expect(oooGroups).toEqual([]);
  });
});

describe("splitOutOfOfficeAllDayGroups", () => {
  it("不在の終日 group を barGroups(AllDayBar 表示用)から除外し、oooGroups へ振り分ける", () => {
    const normal = allDayGroup(allDayOcc({ id: "normal-allday" }));
    const ooo = allDayGroup(allDayOcc({ id: "ooo-allday", isOutOfOffice: true }));

    const { barGroups, oooGroups } = splitOutOfOfficeAllDayGroups([normal, ooo]);

    expect(barGroups).toEqual([normal]);
    expect(oooGroups).toEqual([ooo]);
  });
});

describe("timedOooRailItems", () => {
  const DAY_MS = 24 * 60 * 60_000;
  const dayStartMs = 10 * DAY_MS; // 適当な基準日 0:00
  const dayEndMs = dayStartMs + DAY_MS;

  it("日内に収まる不在を分オフセットへ変換する", () => {
    const startMs = dayStartMs + 9 * 60 * 60_000; // 9:00
    const endMs = dayStartMs + 17 * 60 * 60_000; // 17:00
    const o = occ({ id: "ooo-timed", isOutOfOffice: true, startMs, endMs });

    const items = timedOooRailItems([group(o)], dayStartMs, dayEndMs);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "ooo-timed",
      startMinutes: 9 * 60,
      endMinutes: 17 * 60,
    });
    expect(items[0].subject).toBe(o);
    expect(items[0].groupMembers).toEqual([o]);
  });

  it("日の範囲外の不在は除外する", () => {
    const o = occ({
      id: "ooo-other-day",
      isOutOfOffice: true,
      startMs: dayEndMs + 60_000,
      endMs: dayEndMs + 2 * 60_000,
    });

    expect(timedOooRailItems([group(o)], dayStartMs, dayEndMs)).toEqual([]);
  });

  it("日をまたぐ不在は [dayStartMs, dayEndMs) にクリップする", () => {
    const o = occ({
      id: "ooo-spanning",
      isOutOfOffice: true,
      startMs: dayStartMs - 60 * 60_000, // 前日 23:00
      endMs: dayEndMs + 60 * 60_000, // 翌日 1:00
    });

    const items = timedOooRailItems([group(o)], dayStartMs, dayEndMs);

    expect(items).toHaveLength(1);
    expect(items[0].startMinutes).toBe(0);
    expect(items[0].endMinutes).toBe(24 * 60);
  });
});

describe("allDayOooRailItems", () => {
  it("day を含む終日不在を全高([0, 1440])のレール項目にする", () => {
    const o = allDayOcc({
      id: "ooo-allday-1",
      isOutOfOffice: true,
      startDate: "2026-07-20",
      endDate: "2026-07-22",
    });
    const day = Temporal.PlainDate.from("2026-07-21");

    const items = allDayOooRailItems([allDayGroup(o)], day);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "ooo-allday-1", startMinutes: 0, endMinutes: 24 * 60 });
    expect(items[0].subject).toBe(o);
  });

  it("day を含まない終日不在は除外する", () => {
    const o = allDayOcc({
      id: "ooo-allday-2",
      isOutOfOffice: true,
      startDate: "2026-07-20",
      endDate: "2026-07-20",
    });
    const day = Temporal.PlainDate.from("2026-07-21");

    expect(allDayOooRailItems([allDayGroup(o)], day)).toEqual([]);
  });
});
