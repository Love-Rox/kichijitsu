import { describe, expect, it } from "vite-plus/test";
import { Temporal } from "@js-temporal/polyfill";
import type { AllDayOccurrence } from "../model/types";
import type { AllDayOccurrenceGroup } from "./groupDuplicates";
import {
  buildAllDayPanels,
  clipToVisibleRows,
  resolveSharedRows,
  type RawAllDayPanel,
} from "./allDayPanels";

/**
 * 終日レーンの派生データ(行割り当て → 共有行数 → +N 振り分け)のテスト。
 * ここがズレると終日バーが消える/重なる/パネル間で高さが揃わないため、境界値
 * (maxVisibleRows ちょうど・+1)と複数日バーのあふれ件数を厚めに固定してある。
 */

function allDayOcc(overrides: Partial<AllDayOccurrence> = {}): AllDayOccurrence {
  return {
    id: "g:acc-1:cal-1:allday-1",
    seriesId: null,
    title: "終日予定",
    startDate: "2026-07-20",
    endDate: "2026-07-20",
    color: "#3b82f6",
    source: "google",
    accountId: "acc-1",
    calendarId: "cal-1",
    ...overrides,
  };
}

function grp(id: string, startDate: string, endDate: string, title = id): AllDayOccurrenceGroup {
  const primary = allDayOcc({ id, startDate, endDate, title });
  return { primary, members: [primary] };
}

/** 週ビュー相当の3パネル(2026-07-13/20/27 週の月曜始まり) */
const WEEK_PANEL_STARTS = [
  Temporal.PlainDate.from("2026-07-13"),
  Temporal.PlainDate.from("2026-07-20"),
  Temporal.PlainDate.from("2026-07-27"),
];

/** テスト用の軽い RawAllDayPanel 組み立て(resolveSharedRows/clipToVisibleRows 単体用) */
function rawPanel(
  panelStart: string,
  bars: { id: string; start: number; end: number; row: number; title?: string }[],
): RawAllDayPanel {
  return {
    panelStart: Temporal.PlainDate.from(panelStart),
    bars: bars.map((b) => ({
      group: grp(b.id, "2026-07-20", "2026-07-20", b.title ?? b.id),
      startDayIndex: b.start,
      endDayIndex: b.end,
      row: b.row,
    })),
  };
}

describe("buildAllDayPanels", () => {
  it("パネル数ぶんの結果を panelStarts と同じ順序・同じ日付で返す(WeekGrid の index 整合の前提)", () => {
    const panels = buildAllDayPanels(WEEK_PANEL_STARTS, 7, []);
    expect(panels).toHaveLength(3);
    expect(panels.map((p) => p.panelStart.toString())).toEqual([
      "2026-07-13",
      "2026-07-20",
      "2026-07-27",
    ]);
    expect(panels.every((p) => p.bars.length === 0)).toBe(true);
  });

  it("単日の終日予定は startDayIndex === endDayIndex の1本になる", () => {
    // 2026-07-22(水)は 2026-07-20 始まりパネルの index 2
    const panels = buildAllDayPanels(WEEK_PANEL_STARTS, 7, [
      grp("single", "2026-07-22", "2026-07-22"),
    ]);
    expect(panels[1].bars).toHaveLength(1);
    expect(panels[1].bars[0]).toMatchObject({ startDayIndex: 2, endDayIndex: 2, row: 0 });
    // 他のパネルには掛からない
    expect(panels[0].bars).toEqual([]);
    expect(panels[2].bars).toEqual([]);
  });

  it("複数日にまたがる終日予定は両端 inclusive の日インデックス範囲になる", () => {
    // 2026-07-21(火, index 1)〜2026-07-24(金, index 4)
    const panels = buildAllDayPanels(WEEK_PANEL_STARTS, 7, [
      grp("span", "2026-07-21", "2026-07-24"),
    ]);
    expect(panels[1].bars[0]).toMatchObject({ startDayIndex: 1, endDayIndex: 4 });
  });

  it("パネルの外へ伸びる予定は [0, dayCount-1] にクリップし、掛かるパネル全てに現れる", () => {
    // 2026-07-18(土, 前パネル index 5)〜2026-07-28(火, 次パネル index 1)
    const panels = buildAllDayPanels(WEEK_PANEL_STARTS, 7, [
      grp("long", "2026-07-18", "2026-07-28"),
    ]);
    expect(panels[0].bars[0]).toMatchObject({ startDayIndex: 5, endDayIndex: 6 });
    // 中央パネルは丸ごと覆われるので 0..6 全域
    expect(panels[1].bars[0]).toMatchObject({ startDayIndex: 0, endDayIndex: 6 });
    expect(panels[2].bars[0]).toMatchObject({ startDayIndex: 0, endDayIndex: 1 });
  });

  it("どのパネルにも掛からない予定は除外する", () => {
    const panels = buildAllDayPanels(WEEK_PANEL_STARTS, 7, [
      grp("far-future", "2026-09-01", "2026-09-02"),
      grp("far-past", "2026-01-01", "2026-01-02"),
    ]);
    expect(panels.every((p) => p.bars.length === 0)).toBe(true);
  });

  it("パネル境界ちょうど(先頭日・末日)の予定は含む", () => {
    const panels = buildAllDayPanels(WEEK_PANEL_STARTS, 7, [
      grp("first-day", "2026-07-20", "2026-07-20"),
      grp("last-day", "2026-07-26", "2026-07-26"),
    ]);
    const bars = panels[1].bars;
    expect(bars).toHaveLength(2);
    expect(bars.map((b) => [b.startDayIndex, b.endDayIndex])).toEqual([
      [0, 0],
      [6, 6],
    ]);
  });

  it("日が重なる予定は別の行に、重ならない予定は同じ行に詰める(packDayBars の再利用)", () => {
    const panels = buildAllDayPanels(WEEK_PANEL_STARTS, 7, [
      grp("a", "2026-07-20", "2026-07-22"), // index 0-2
      grp("b", "2026-07-21", "2026-07-23"), // index 1-3(a と重なる)
      grp("c", "2026-07-24", "2026-07-25"), // index 4-5(a の後なので row0 を再利用)
    ]);
    const rowOf = (id: string) => panels[1].bars.find((b) => b.group.primary.id === id)?.row;
    expect(rowOf("a")).toBe(0);
    expect(rowOf("b")).toBe(1);
    expect(rowOf("c")).toBe(0);
  });

  it("dayCount=1(1日ビュー)でも同じ形で動く", () => {
    const starts = [
      Temporal.PlainDate.from("2026-07-21"),
      Temporal.PlainDate.from("2026-07-22"),
      Temporal.PlainDate.from("2026-07-23"),
    ];
    const panels = buildAllDayPanels(starts, 1, [grp("span", "2026-07-20", "2026-07-24")]);
    // 各パネルは1日ぶんしか無いので全て [0,0] にクリップされる
    expect(panels.map((p) => p.bars[0])).toEqual([
      expect.objectContaining({ startDayIndex: 0, endDayIndex: 0 }),
      expect.objectContaining({ startDayIndex: 0, endDayIndex: 0 }),
      expect.objectContaining({ startDayIndex: 0, endDayIndex: 0 }),
    ]);
  });

  it("入力の group 配列を破壊的に変更しない", () => {
    const groups = [grp("a", "2026-07-20", "2026-07-22"), grp("b", "2026-07-21", "2026-07-23")];
    const snapshot = [...groups];
    buildAllDayPanels(WEEK_PANEL_STARTS, 7, groups);
    expect(groups).toEqual(snapshot);
  });
});

describe("resolveSharedRows", () => {
  it("バーが1本も無ければ visibleRows は 0(レーンごと非表示になる)", () => {
    expect(resolveSharedRows([rawPanel("2026-07-20", [])], 3)).toEqual({
      visibleRows: 0,
      hasOverflow: false,
    });
  });

  it("最大行数が maxVisibleRows 未満ならその行数だけ確保し、あふれは無い", () => {
    const panels = [
      rawPanel("2026-07-20", [
        { id: "a", start: 0, end: 0, row: 0 },
        { id: "b", start: 0, end: 0, row: 1 },
      ]),
    ];
    expect(resolveSharedRows(panels, 3)).toEqual({ visibleRows: 2, hasOverflow: false });
  });

  it("境界: 行番号が maxVisibleRows-1 (=ちょうど maxVisibleRows 行) ならあふれない", () => {
    const panels = [rawPanel("2026-07-20", [{ id: "a", start: 0, end: 0, row: 2 }])];
    expect(resolveSharedRows(panels, 3)).toEqual({ visibleRows: 3, hasOverflow: false });
  });

  it("境界: 行番号が maxVisibleRows (=1行超え) ならあふれ、visibleRows は maxVisibleRows で止まる", () => {
    const panels = [rawPanel("2026-07-20", [{ id: "a", start: 0, end: 0, row: 3 }])];
    expect(resolveSharedRows(panels, 3)).toEqual({ visibleRows: 3, hasOverflow: true });
  });

  it("3パネルで行数が違う場合は最大のパネルに合わせる(スライド中に高さが変わらないため)", () => {
    const panels = [
      rawPanel("2026-07-13", [{ id: "a", start: 0, end: 0, row: 0 }]),
      rawPanel("2026-07-20", [{ id: "b", start: 0, end: 0, row: 1 }]),
      rawPanel("2026-07-27", [{ id: "c", start: 0, end: 0, row: 0 }]),
    ];
    expect(resolveSharedRows(panels, 3)).toEqual({ visibleRows: 2, hasOverflow: false });
  });

  it("3パネルのうち1パネルだけ溢れていても hasOverflow は全体で true になる", () => {
    const panels = [
      rawPanel("2026-07-13", [{ id: "a", start: 0, end: 0, row: 0 }]),
      rawPanel("2026-07-20", [{ id: "b", start: 0, end: 0, row: 4 }]),
      rawPanel("2026-07-27", [{ id: "c", start: 0, end: 0, row: 1 }]),
    ];
    expect(resolveSharedRows(panels, 3)).toEqual({ visibleRows: 3, hasOverflow: true });
  });

  it("maxVisibleRows=1 でも成り立つ(2行目以降は全てあふれ)", () => {
    const panels = [
      rawPanel("2026-07-20", [
        { id: "a", start: 0, end: 0, row: 0 },
        { id: "b", start: 0, end: 0, row: 1 },
      ]),
    ];
    expect(resolveSharedRows(panels, 1)).toEqual({ visibleRows: 1, hasOverflow: true });
  });
});

describe("clipToVisibleRows", () => {
  it("visibleRows 未満の行だけを visibleBars に残す", () => {
    const panels = [
      rawPanel("2026-07-20", [
        { id: "a", start: 0, end: 0, row: 0 },
        { id: "b", start: 0, end: 0, row: 1 },
        { id: "c", start: 0, end: 0, row: 2 },
        { id: "d", start: 0, end: 0, row: 3 },
      ]),
    ];
    const [panel] = clipToVisibleRows(panels, 3, 7);
    expect(panel.visibleBars.map((b) => b.group.primary.id)).toEqual(["a", "b", "c"]);
  });

  it("overflowByDay は常に dayCount 個ぶん存在し、あふれの無い日は count 0", () => {
    const panels = [rawPanel("2026-07-20", [{ id: "a", start: 0, end: 0, row: 0 }])];
    const [panel] = clipToVisibleRows(panels, 3, 7);
    expect(panel.overflowByDay).toHaveLength(7);
    expect(panel.overflowByDay.every((o) => o.count === 0 && o.titles.length === 0)).toBe(true);
  });

  it("あふれた単日バーはその日だけ +1 され、タイトルが記録される", () => {
    const panels = [
      rawPanel("2026-07-20", [{ id: "x", start: 2, end: 2, row: 3, title: "隠れた予定" }]),
    ];
    const [panel] = clipToVisibleRows(panels, 3, 7);
    expect(panel.visibleBars).toEqual([]);
    expect(panel.overflowByDay[2]).toEqual({ count: 1, titles: ["隠れた予定"] });
    expect(panel.overflowByDay[1].count).toBe(0);
    expect(panel.overflowByDay[3].count).toBe(0);
  });

  it("あふれた複数日バーは掛かる全ての日の +N を増やす(端の外は増えない)", () => {
    const panels = [
      rawPanel("2026-07-20", [{ id: "x", start: 1, end: 4, row: 3, title: "長い予定" }]),
    ];
    const [panel] = clipToVisibleRows(panels, 3, 7);
    expect(panel.overflowByDay.map((o) => o.count)).toEqual([0, 1, 1, 1, 1, 0, 0]);
    expect(panel.overflowByDay[3].titles).toEqual(["長い予定"]);
  });

  it("同じ日に複数あふれると count が積算され、titles は bars の順に並ぶ", () => {
    const panels = [
      rawPanel("2026-07-20", [
        { id: "x", start: 0, end: 6, row: 3, title: "あふれ1" },
        { id: "y", start: 3, end: 3, row: 4, title: "あふれ2" },
      ]),
    ];
    const [panel] = clipToVisibleRows(panels, 3, 7);
    expect(panel.overflowByDay[3]).toEqual({ count: 2, titles: ["あふれ1", "あふれ2"] });
    expect(panel.overflowByDay[0]).toEqual({ count: 1, titles: ["あふれ1"] });
  });

  it("visibleRows=0 なら全バーがあふれる", () => {
    const panels = [
      rawPanel("2026-07-20", [
        { id: "a", start: 0, end: 0, row: 0, title: "A" },
        { id: "b", start: 0, end: 0, row: 1, title: "B" },
      ]),
    ];
    const [panel] = clipToVisibleRows(panels, 0, 7);
    expect(panel.visibleBars).toEqual([]);
    expect(panel.overflowByDay[0]).toEqual({ count: 2, titles: ["A", "B"] });
  });

  it("パネルごとに独立した overflowByDay 配列を返す(共有参照によるカウント混線が無い)", () => {
    const panels = [
      rawPanel("2026-07-13", [{ id: "a", start: 0, end: 0, row: 3, title: "A" }]),
      rawPanel("2026-07-20", []),
    ];
    const result = clipToVisibleRows(panels, 3, 7);
    expect(result[0].overflowByDay[0].count).toBe(1);
    expect(result[1].overflowByDay[0].count).toBe(0);
    expect(result[0].overflowByDay).not.toBe(result[1].overflowByDay);
    expect(result.map((p) => p.panelStart.toString())).toEqual(["2026-07-13", "2026-07-20"]);
  });
});

describe("3段の通し(WeekGrid.tsx が呼ぶのと同じ順序)", () => {
  it("4本重なる日があるとき、3行まで表示して残り1本を +1 に畳む", () => {
    const groups = [
      grp("a", "2026-07-20", "2026-07-21", "A"),
      grp("b", "2026-07-20", "2026-07-21", "B"),
      grp("c", "2026-07-20", "2026-07-21", "C"),
      grp("d", "2026-07-20", "2026-07-21", "D"),
    ];
    const raw = buildAllDayPanels(WEEK_PANEL_STARTS, 7, groups);
    const { visibleRows, hasOverflow } = resolveSharedRows(raw, 3);
    expect({ visibleRows, hasOverflow }).toEqual({ visibleRows: 3, hasOverflow: true });

    const panels = clipToVisibleRows(raw, visibleRows, 7);
    expect(panels[1].visibleBars.map((b) => b.group.primary.id)).toEqual(["a", "b", "c"]);
    // d は 2026-07-20(index 0)と 07-21(index 1)の両日で +1
    expect(panels[1].overflowByDay.map((o) => o.count)).toEqual([1, 1, 0, 0, 0, 0, 0]);
    expect(panels[1].overflowByDay[0].titles).toEqual(["D"]);
    // 掛からないパネルは影響を受けない
    expect(panels[0].visibleBars).toEqual([]);
    expect(panels[0].overflowByDay.every((o) => o.count === 0)).toBe(true);
  });

  it("3本までしか重ならないなら +N 行は確保されない(hasOverflow=false)", () => {
    const groups = [
      grp("a", "2026-07-20", "2026-07-21", "A"),
      grp("b", "2026-07-20", "2026-07-21", "B"),
      grp("c", "2026-07-20", "2026-07-21", "C"),
    ];
    const raw = buildAllDayPanels(WEEK_PANEL_STARTS, 7, groups);
    const { visibleRows, hasOverflow } = resolveSharedRows(raw, 3);
    expect({ visibleRows, hasOverflow }).toEqual({ visibleRows: 3, hasOverflow: false });
    const panels = clipToVisibleRows(raw, visibleRows, 7);
    expect(panels[1].visibleBars).toHaveLength(3);
    expect(panels[1].overflowByDay.every((o) => o.count === 0)).toBe(true);
  });
});
