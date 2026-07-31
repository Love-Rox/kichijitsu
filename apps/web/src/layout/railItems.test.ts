import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_HOUR_HEIGHT } from "./gridMetrics";
import {
  packDayRailBands,
  railBandColumnCount,
  railItemsForDay,
  type RailSpan,
} from "./railItems";

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

/**
 * その日のレール全体の列パッキング(2026-07-30、終日の不在の全高ラインが他の帯と重なる
 * 不具合の修正)。
 *
 * ここで固定したい核心は2つ:
 *   1. 全高ライン([0, 1440])が他の帯と同じ列を使わない = 重ならない
 *   2. **終日の不在が無い日は列の割り当てが一切変わらない**(修正の安全弁)
 * 2 は「全高ラインを配列から抜くと、修正前と同じ入力・同じ結果になる」という形で確かめる ――
 * この層は subject を見ないので、素の RailSpan だけでテストできる。
 */
const MINUTES_PER_DAY = 24 * 60;

function span(id: string, startMinutes: number, endMinutes: number): RailSpan {
  return { id, startMinutes, endMinutes };
}

/** 終日の不在(全高ライン)1本ぶん。oooRail.ts の allDayOooRailItems が作る範囲と同じ */
function fullHeight(id: string): RailSpan {
  return span(id, 0, MINUTES_PER_DAY);
}

/** id → column の Map(列の割り当てだけを比較しやすくする) */
function columnsById(packed: ReturnType<typeof packDayRailBands<RailSpan, RailSpan>>) {
  const out: Record<string, number> = {};
  for (const p of packed) out[p.item.id] = p.column;
  return out;
}

function pack(ooo: RailSpan[], workloc: RailSpan[]) {
  return packDayRailBands<RailSpan, RailSpan>(ooo, workloc, DEFAULT_HOUR_HEIGHT);
}

describe("packDayRailBands", () => {
  it("帯が1本も無ければ空(列数0)", () => {
    const packed = pack([], []);
    expect(packed).toEqual([]);
    expect(railBandColumnCount(packed)).toBe(0);
  });

  it("全高ライン1本だけなら列0・1列(終日の不在しか無い日の従来の見え方と同じ幅)", () => {
    const packed = pack([fullHeight("allday-ooo")], []);
    expect(columnsById(packed)).toEqual({ "allday-ooo": 0 });
    expect(railBandColumnCount(packed)).toBe(1);
  });

  it("全高ラインと勤務場所の区間は別の列に分かれる(これが修正の本題)", () => {
    // 修正前は全高ラインがパッキングを通らず常に left: 0 で、勤務場所も列0から使うため
    // 必ず重なっていた
    const packed = pack([fullHeight("allday-ooo")], [span("wl", 600, 960)]);
    const cols = columnsById(packed);
    expect(cols["allday-ooo"]).toBe(0);
    expect(cols.wl).toBe(1);
    expect(railBandColumnCount(packed)).toBe(2);
  });

  it("全高ライン + 勤務場所 + 時刻の不在は3列になる(全高ラインが列0)", () => {
    const packed = pack(
      [fullHeight("allday-ooo"), span("timed-ooo", 780, 900)],
      [span("wl", 600, 960)],
    );
    expect(columnsById(packed)).toEqual({ "allday-ooo": 0, wl: 1, "timed-ooo": 2 });
    expect(railBandColumnCount(packed)).toBe(3);
  });

  it("全高ラインが2本ある日も互いに重ならない(修正前は完全に重なっていた)", () => {
    const packed = pack([fullHeight("a"), fullHeight("b")], []);
    expect(columnsById(packed)).toEqual({ a: 0, b: 1 });
    expect(railBandColumnCount(packed)).toBe(2);
  });

  it("1日を丸ごと覆う時刻の不在とタイになっても、全高ラインが列0に来る(渡す順序の約束)", () => {
    // 既定の "timeline" 設定では、dateTime で 0:00→翌 0:00 の不在も [0, 1440] の帯として
    // レールに来る。開始も実効長も完全に一致するので、決め手は入力順(安定ソート)だけ ――
    // 呼び出し元 (DayColumn.tsx) が全高ラインを先に渡す約束をここで固定する
    const packed = pack([fullHeight("allday-ooo"), span("timed-fullday", 0, MINUTES_PER_DAY)], []);
    expect(columnsById(packed)).toEqual({ "allday-ooo": 0, "timed-fullday": 1 });
  });

  it("kind と元項目を保持する(描画側が variant を選べる)", () => {
    const ooo = fullHeight("allday-ooo");
    const wl = span("wl", 600, 960);
    const packed = pack([ooo], [wl]);
    const oooBand = packed.find((p) => p.item.id === "allday-ooo")?.item;
    const wlBand = packed.find((p) => p.item.id === "wl")?.item;
    expect(oooBand?.kind).toBe("ooo");
    expect(wlBand?.kind).toBe("workingLocation");
    // 元項目は参照のまま渡る(ツールチップ・詳細ポップオーバーが subject を辿るため)
    expect(oooBand?.kind === "ooo" && oooBand.oooItem).toBe(ooo);
    expect(wlBand?.kind === "workingLocation" && wlBand.workingLocationItem).toBe(wl);
  });

  it("終日の不在が無い日は列の割り当てが変わらない(この修正の安全弁)", () => {
    // 修正で変わったのは「全高ラインも入力に混ぜる」ことだけなので、全高ラインが無い日は
    // 入力配列が修正前と一字一句同じ = 結果も同じ。代表的な3パターンで固定する。
    // 重ならない時刻の不在 + 勤務場所 → すべて列0(縦に並ぶ)
    const apart = pack([span("ooo", 540, 720)], [span("wl", 780, 960)]);
    expect(columnsById(apart)).toEqual({ ooo: 0, wl: 0 });
    expect(railBandColumnCount(apart)).toBe(1);
    // 重なる時刻の不在 + 勤務場所 → 2列(不在が先に渡るので列0)
    const overlap = pack([span("ooo", 540, 900)], [span("wl", 780, 960)]);
    expect(columnsById(overlap)).toEqual({ ooo: 0, wl: 1 });
    expect(railBandColumnCount(overlap)).toBe(2);
    // 勤務場所の区間だけの日(区間どうしは定義上重ならない) → 1列
    const segments = pack([], [span("wl-1", 0, 540), span("wl-2", 540, 1440)]);
    expect(columnsById(segments)).toEqual({ "wl-1": 0, "wl-2": 0 });
    expect(railBandColumnCount(segments)).toBe(1);
  });

  it("入力配列を破壊的に変更しない", () => {
    const ooo = [fullHeight("allday-ooo"), span("timed-ooo", 780, 900)];
    const workloc = [span("wl", 600, 960)];
    const oooSnapshot = structuredClone(ooo);
    const worklocSnapshot = structuredClone(workloc);
    pack(ooo, workloc);
    expect(ooo).toEqual(oooSnapshot);
    expect(workloc).toEqual(worklocSnapshot);
  });
});
