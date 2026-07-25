import { describe, expect, it } from "vite-plus/test";
import { railItemsForDay } from "./railItems";

/**
 * レール項目生成の generic 本体のテスト(2026-07-26 に oooRail.ts / workingLocationRail.ts の
 * 同一実装2本をここへ統合した)。OOO 固有・勤務場所固有の振り分け(splitOutOfOfficeGroups /
 * splitWorkingLocationGroups)とラッパー経由の挙動は従来どおり oooRail.test.ts /
 * workingLocationRail.test.ts が固定し、ここでは「クリップと分オフセット変換」だけを見る。
 *
 * subject は TimedSubject(id/startMs/endMs)を満たす最小の形で十分 ―― この層は
 * Occurrence の他のフィールドを一切参照しないことを、この最小型のテストが示している。
 */

interface TestSubject {
  id: string;
  startMs: number;
  endMs: number;
}

const DAY_MS = 24 * 60 * 60_000;
const dayStartMs = 10 * DAY_MS; // 適当な基準日 0:00
const dayEndMs = dayStartMs + DAY_MS;

function group(primary: TestSubject, members: TestSubject[] = [primary]) {
  return { primary, members };
}

describe("railItemsForDay", () => {
  it("空配列は空配列を返す", () => {
    expect(railItemsForDay([], dayStartMs, dayEndMs)).toEqual([]);
  });

  it("日内に収まる区間を分オフセットへ変換する", () => {
    const s = {
      id: "in-day",
      startMs: dayStartMs + 9 * 60 * 60_000, // 9:00
      endMs: dayStartMs + 17 * 60 * 60_000, // 17:00
    };
    const items = railItemsForDay([group(s)], dayStartMs, dayEndMs);
    expect(items).toEqual([
      { id: "in-day", subject: s, groupMembers: [s], startMinutes: 540, endMinutes: 1020 },
    ]);
  });

  it("groupMembers はグループの members をそのまま渡す(参照も維持)", () => {
    const primary = { id: "a", startMs: dayStartMs, endMs: dayStartMs + 60_000 };
    const other = { id: "a-copy", startMs: dayStartMs, endMs: dayStartMs + 60_000 };
    const members = [primary, other];
    const items = railItemsForDay([group(primary, members)], dayStartMs, dayEndMs);
    expect(items[0].groupMembers).toBe(members);
    expect(items[0].subject).toBe(primary);
  });

  it("日より前に終わる/日より後に始まる区間は除外する(半開区間の境界)", () => {
    const endsAtDayStart = { id: "ends-at-start", startMs: dayStartMs - 60_000, endMs: dayStartMs };
    const startsAtDayEnd = { id: "starts-at-end", startMs: dayEndMs, endMs: dayEndMs + 60_000 };
    expect(
      railItemsForDay([group(endsAtDayStart), group(startsAtDayEnd)], dayStartMs, dayEndMs),
    ).toEqual([]);
  });

  it("日をまたぐ区間は [dayStartMs, dayEndMs) にクリップする", () => {
    const s = {
      id: "spanning",
      startMs: dayStartMs - 60 * 60_000, // 前日 23:00
      endMs: dayEndMs + 60 * 60_000, // 翌日 1:00
    };
    const items = railItemsForDay([group(s)], dayStartMs, dayEndMs);
    expect(items[0].startMinutes).toBe(0);
    expect(items[0].endMinutes).toBe(24 * 60);
  });

  it("クリップ後の幅が0でも最低1分ぶんの高さを確保する(高さ0の帯は見えないため)", () => {
    const s = {
      id: "zero-width",
      startMs: dayEndMs - 30_000, // 日終了30秒前に開始
      endMs: dayEndMs + 60_000, // 日をまたいで終了
    };
    const items = railItemsForDay([group(s)], dayStartMs, dayEndMs);
    expect(items[0].endMinutes - items[0].startMinutes).toBe(1);
  });

  it("startMs === endMs(長さ0)の区間でも1分ぶんの高さになる", () => {
    const at = dayStartMs + 12 * 60 * 60_000; // 12:00
    const s = { id: "instant", startMs: at, endMs: at };
    const items = railItemsForDay([group(s)], dayStartMs, dayEndMs);
    expect(items[0].startMinutes).toBe(720);
    expect(items[0].endMinutes).toBe(721);
  });

  it("複数件は入力順のまま返す(並べ替えはこの層の責務ではない ―― 列パッキングは railStack.ts)", () => {
    const late = { id: "late", startMs: dayStartMs + 20 * 60 * 60_000, endMs: dayEndMs };
    const early = { id: "early", startMs: dayStartMs, endMs: dayStartMs + 60 * 60_000 };
    const items = railItemsForDay([group(late), group(early)], dayStartMs, dayEndMs);
    expect(items.map((i) => i.id)).toEqual(["late", "early"]);
  });

  it("入力配列を破壊的に変更しない", () => {
    const groups = [
      group({ id: "a", startMs: dayStartMs, endMs: dayStartMs + 60_000 }),
      group({ id: "b", startMs: dayStartMs + 120_000, endMs: dayStartMs + 180_000 }),
    ];
    const snapshot = structuredClone(groups);
    railItemsForDay(groups, dayStartMs, dayEndMs);
    expect(groups).toEqual(snapshot);
  });
});
