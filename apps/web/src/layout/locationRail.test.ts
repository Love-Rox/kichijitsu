import { describe, expect, it } from "vite-plus/test";
import type { Occurrence } from "../model/types";
import { isLocationRailCandidate, locationRailItems } from "./locationRail";

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

describe("isLocationRailCandidate", () => {
  it("location が非空で OOO/Busy/勤務場所のいずれでもなければ true", () => {
    expect(isLocationRailCandidate(occ({ location: "会議室A" }))).toBe(true);
  });

  it("location が無ければ false", () => {
    expect(isLocationRailCandidate(occ({ location: undefined }))).toBe(false);
    expect(isLocationRailCandidate(occ({ location: "" }))).toBe(false);
  });

  it("不在(OOO)は false(専用レールに既に出るため)", () => {
    expect(isLocationRailCandidate(occ({ location: "会議室A", isOutOfOffice: true }))).toBe(false);
  });

  it("Busy プレースホルダ(タイトルが Busy/予定あり)は false", () => {
    expect(isLocationRailCandidate(occ({ location: "会議室A", title: "Busy" }))).toBe(false);
    expect(isLocationRailCandidate(occ({ location: "会議室A", title: "予定あり" }))).toBe(false);
  });

  it("勤務場所(isWorkingLocation)は false", () => {
    expect(isLocationRailCandidate(occ({ location: "会議室A", isWorkingLocation: true }))).toBe(
      false,
    );
  });

  it("オンライン会議(hasConference)でも location があれば true(対象外にしない)", () => {
    expect(isLocationRailCandidate(occ({ location: "会議室A", hasConference: true }))).toBe(true);
  });
});

describe("locationRailItems", () => {
  const DAY_MS = 24 * 60 * 60_000;
  const dayStartMs = 10 * DAY_MS; // 適当な基準日 0:00
  const dayEndMs = dayStartMs + DAY_MS;

  it("location 付きの時刻予定を分オフセットへ変換する", () => {
    const startMs = dayStartMs + 9 * 60 * 60_000; // 9:00
    const endMs = dayStartMs + 10 * 60 * 60_000; // 10:00
    const o = occ({ id: "loc-1", location: "会議室A", startMs, endMs });

    const items = locationRailItems([o], dayStartMs, dayEndMs);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "loc-1", startMinutes: 9 * 60 });
    expect(items[0].subject).toBe(o);
  });

  it("location が無い予定は除外する", () => {
    const o = occ({ id: "no-loc", startMs: dayStartMs, endMs: dayStartMs + 60_000 });
    expect(locationRailItems([o], dayStartMs, dayEndMs)).toEqual([]);
  });

  it("不在(OOO)は除外する(専用レールに既に出るため二重に出さない)", () => {
    const o = occ({
      id: "ooo",
      location: "会議室A",
      isOutOfOffice: true,
      startMs: dayStartMs,
      endMs: dayStartMs + 60_000,
    });
    expect(locationRailItems([o], dayStartMs, dayEndMs)).toEqual([]);
  });

  it("Busy プレースホルダは除外する", () => {
    const o = occ({
      id: "busy",
      title: "Busy",
      location: "会議室A",
      startMs: dayStartMs,
      endMs: dayStartMs + 60_000,
    });
    expect(locationRailItems([o], dayStartMs, dayEndMs)).toEqual([]);
  });

  it("勤務場所(isWorkingLocation)は除外する", () => {
    const o = occ({
      id: "working-loc",
      location: "自宅",
      isWorkingLocation: true,
      startMs: dayStartMs,
      endMs: dayStartMs + 60_000,
    });
    expect(locationRailItems([o], dayStartMs, dayEndMs)).toEqual([]);
  });

  it("日の範囲外の予定は除外する", () => {
    const o = occ({
      id: "other-day",
      location: "会議室A",
      startMs: dayEndMs + 60_000,
      endMs: dayEndMs + 2 * 60_000,
    });
    expect(locationRailItems([o], dayStartMs, dayEndMs)).toEqual([]);
  });

  it("日をまたぐ予定は開始側を [dayStartMs, dayEndMs) の 0:00 にクリップする", () => {
    const o = occ({
      id: "spanning",
      location: "会議室A",
      startMs: dayStartMs - 60 * 60_000, // 前日 23:00 開始
      endMs: dayEndMs + 60 * 60_000, // 翌日 1:00 終了
    });

    const items = locationRailItems([o], dayStartMs, dayEndMs);

    expect(items).toHaveLength(1);
    expect(items[0].startMinutes).toBe(0);
  });
});
