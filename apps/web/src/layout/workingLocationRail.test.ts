import { describe, expect, it } from "vite-plus/test";
import type { AllDayOccurrence, Occurrence } from "../model/types";
import type { OccurrenceGroup } from "./groupDuplicates";
import {
  isWorkingLocation,
  splitWorkingLocationGroups,
  timedWorkingLocationRailItems,
} from "./workingLocationRail";

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
    title: "自宅",
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

describe("isWorkingLocation", () => {
  it("isWorkingLocation: true のときだけ true を返す", () => {
    expect(isWorkingLocation({ isWorkingLocation: true })).toBe(true);
    expect(isWorkingLocation({ isWorkingLocation: false })).toBe(false);
    expect(isWorkingLocation({})).toBe(false);
  });

  it("location フィールドを持つだけの普通の予定は対象外(取り違え再発防止)", () => {
    // isWorkingLocation はあくまで isWorkingLocation フラグだけを見る。location の
    // 有無はこの関数の入力にすら含まれない ―― 呼び出し側 (splitWorkingLocationGroups) が
    // occurrence.location を一切参照しないことを型レベルでも保証している。
    expect(isWorkingLocation(occ({ location: "会議室A" }))).toBe(false);
  });

  it("終日予定(AllDayOccurrence)にも構造的に同じ判定を適用できる(AllDayBar.tsx が直接呼ぶ想定)", () => {
    // このファイルはもう終日専用の split/rail 関数を持たない(2026-07-22 終日レーンへ統合)。
    // 終日の勤務場所判定は AllDayBar.tsx がこの isWorkingLocation を直接呼ぶだけなので、
    // AllDayOccurrence 形の入力でも正しく判定できることをここで固定しておく。
    expect(isWorkingLocation(allDayOcc({ isWorkingLocation: true }))).toBe(true);
    expect(isWorkingLocation(allDayOcc({ isWorkingLocation: false }))).toBe(false);
    // location だけがあり isWorkingLocation でない終日予定も対象外(取り違え再発防止、時刻予定と対称)
    expect(isWorkingLocation(allDayOcc({ location: "実家" }))).toBe(false);
  });
});

describe("splitWorkingLocationGroups", () => {
  it("勤務場所の group を cardGroups から除外し、workingLocationGroups へ振り分ける(packColumns 入力からの除外)", () => {
    const normal = group(occ({ id: "normal-1" }));
    const workingLoc = group(occ({ id: "wl-1", isWorkingLocation: true }));

    const { cardGroups, workingLocationGroups } = splitWorkingLocationGroups([normal, workingLoc]);

    expect(cardGroups).toEqual([normal]);
    expect(workingLocationGroups).toEqual([workingLoc]);
  });

  it("location はあるが isWorkingLocation でない普通の予定は cardGroups に残る(レールに出ない、取り違え再発防止)", () => {
    const normalWithLocation = group(occ({ id: "normal-with-loc", location: "会議室A" }));

    const { cardGroups, workingLocationGroups } = splitWorkingLocationGroups([normalWithLocation]);

    expect(cardGroups).toEqual([normalWithLocation]);
    expect(workingLocationGroups).toEqual([]);
  });

  it("勤務場所が無ければ workingLocationGroups は空、cardGroups は全件そのまま", () => {
    const a = group(occ({ id: "a" }));
    const b = group(occ({ id: "b" }));

    const { cardGroups, workingLocationGroups } = splitWorkingLocationGroups([a, b]);

    expect(cardGroups).toEqual([a, b]);
    expect(workingLocationGroups).toEqual([]);
  });
});

describe("timedWorkingLocationRailItems", () => {
  const DAY_MS = 24 * 60 * 60_000;
  const dayStartMs = 10 * DAY_MS; // 適当な基準日 0:00
  const dayEndMs = dayStartMs + DAY_MS;

  it("日内に収まる勤務場所を開始〜終了の分オフセット範囲(startMinutes/endMinutes)へ変換する(帯化)", () => {
    const startMs = dayStartMs + 9 * 60 * 60_000; // 9:00
    const endMs = dayStartMs + 17 * 60 * 60_000; // 17:00
    const o = occ({ id: "wl-timed", isWorkingLocation: true, startMs, endMs });

    const items = timedWorkingLocationRailItems([group(o)], dayStartMs, dayEndMs);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "wl-timed", startMinutes: 9 * 60, endMinutes: 17 * 60 });
    expect(items[0].subject).toBe(o);
    expect(items[0].groupMembers).toEqual([o]);
  });

  it("日の範囲外の勤務場所は除外する", () => {
    const o = occ({
      id: "wl-other-day",
      isWorkingLocation: true,
      startMs: dayEndMs + 60_000,
      endMs: dayEndMs + 2 * 60_000,
    });

    expect(timedWorkingLocationRailItems([group(o)], dayStartMs, dayEndMs)).toEqual([]);
  });

  it("日をまたぐ勤務場所は [dayStartMs, dayEndMs) にクリップする(開始は 0:00、終了は 24:00 相当)", () => {
    const o = occ({
      id: "wl-spanning",
      isWorkingLocation: true,
      startMs: dayStartMs - 60 * 60_000, // 前日 23:00 開始
      endMs: dayEndMs + 60 * 60_000, // 翌日 1:00 終了
    });

    const items = timedWorkingLocationRailItems([group(o)], dayStartMs, dayEndMs);

    expect(items).toHaveLength(1);
    expect(items[0].startMinutes).toBe(0);
    expect(items[0].endMinutes).toBe(24 * 60);
  });

  it("クリップ後の幅が0でも最低1分ぶんの高さを確保する", () => {
    const o = occ({
      id: "wl-zero-width",
      isWorkingLocation: true,
      startMs: dayEndMs - 30_000, // 日終了30秒前に開始
      endMs: dayEndMs + 60_000, // 日をまたいで終了
    });

    const items = timedWorkingLocationRailItems([group(o)], dayStartMs, dayEndMs);

    expect(items).toHaveLength(1);
    expect(items[0].endMinutes).toBeGreaterThan(items[0].startMinutes);
  });
});

describe("終日の勤務場所はレールを経由しない(2026-07-22 終日レーンへ統合)", () => {
  it("このファイルは終日専用の split/rail 関数を持たない ―― timedWorkingLocationRailItems/splitWorkingLocationGroups は OccurrenceGroup[](時刻予定)のみを受け取る型なので、AllDayOccurrenceGroup を渡すコードは型検査で弾かれる", () => {
    // 実行時アサーションではなくコンパイル時の保証だが、意図を明示するためテストとして残す。
    // 終日の勤務場所は WeekGrid.tsx が barGroups から分離しなくなり、他の終日予定と同じ
    // 経路(packDayBars → AllDayBar)を通る。AllDayBar.tsx は isWorkingLocation(occurrence)
    // (上の describe で固定した挙動)だけを見て `.allday-bar--working-location` の見た目に
    // 分岐させる ―― この層に「終日用のレール項目」という概念自体がもう存在しない。
    const wl = allDayOcc({ id: "wl-allday", isWorkingLocation: true });
    expect(isWorkingLocation(wl)).toBe(true);
  });
});
