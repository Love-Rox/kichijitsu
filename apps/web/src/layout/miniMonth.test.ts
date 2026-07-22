import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vite-plus/test";
import { activeMonthAnchor, isMiniMonthHighlighted, resolveMiniMonthNavigation } from "./miniMonth";

describe("activeMonthAnchor", () => {
  it("month ビューでは monthCursor をそのまま返す", () => {
    const timelineStart = Temporal.PlainDate.from("2026-07-20");
    const monthCursor = Temporal.PlainDate.from("2026-08-01");
    expect(activeMonthAnchor("month", timelineStart, monthCursor).toString()).toBe("2026-08-01");
  });

  it.each(["week", "day3", "day1"] as const)(
    "%s ビューでは timelineStart をそのまま返す",
    (view) => {
      const timelineStart = Temporal.PlainDate.from("2026-07-20");
      const monthCursor = Temporal.PlainDate.from("2026-08-01");
      expect(activeMonthAnchor(view, timelineStart, monthCursor).toString()).toBe("2026-07-20");
    },
  );
});

describe("isMiniMonthHighlighted", () => {
  const timelineStart = Temporal.PlainDate.from("2026-07-20"); // 月曜
  const monthCursor = Temporal.PlainDate.from("2026-08-01");

  it("week ビュー: [timelineStart, +7日) の範囲内は true", () => {
    expect(
      isMiniMonthHighlighted(
        Temporal.PlainDate.from("2026-07-20"),
        "week",
        timelineStart,
        7,
        monthCursor,
      ),
    ).toBe(true);
    expect(
      isMiniMonthHighlighted(
        Temporal.PlainDate.from("2026-07-26"),
        "week",
        timelineStart,
        7,
        monthCursor,
      ),
    ).toBe(true);
  });

  it("week ビュー: 範囲外(前日・8日目)は false", () => {
    expect(
      isMiniMonthHighlighted(
        Temporal.PlainDate.from("2026-07-19"),
        "week",
        timelineStart,
        7,
        monthCursor,
      ),
    ).toBe(false);
    expect(
      isMiniMonthHighlighted(
        Temporal.PlainDate.from("2026-07-27"),
        "week",
        timelineStart,
        7,
        monthCursor,
      ),
    ).toBe(false);
  });

  it("day1 ビュー: dayCount=1 なので timelineStart 当日のみ true", () => {
    expect(
      isMiniMonthHighlighted(
        Temporal.PlainDate.from("2026-07-20"),
        "day1",
        timelineStart,
        1,
        monthCursor,
      ),
    ).toBe(true);
    expect(
      isMiniMonthHighlighted(
        Temporal.PlainDate.from("2026-07-21"),
        "day1",
        timelineStart,
        1,
        monthCursor,
      ),
    ).toBe(false);
  });

  it("month ビュー: monthCursor と同じ月の全日が true(timelineStart は無関係)", () => {
    expect(
      isMiniMonthHighlighted(
        Temporal.PlainDate.from("2026-08-15"),
        "month",
        timelineStart,
        7,
        monthCursor,
      ),
    ).toBe(true);
  });

  it("month ビュー: 違う月は false", () => {
    expect(
      isMiniMonthHighlighted(
        Temporal.PlainDate.from("2026-07-31"),
        "month",
        timelineStart,
        7,
        monthCursor,
      ),
    ).toBe(false);
  });
});

describe("resolveMiniMonthNavigation", () => {
  it("month ビュー: クリックした日が属する月の1日を返す", () => {
    const target = resolveMiniMonthNavigation("month", Temporal.PlainDate.from("2026-08-15"));
    expect(target).toEqual({ kind: "month", date: Temporal.PlainDate.from("2026-08-01") });
  });

  it("week ビュー: クリックした日を含む週の月曜(mondayOf)を返す", () => {
    // 2026-07-22(水)をクリック → その週の月曜 2026-07-20
    const target = resolveMiniMonthNavigation("week", Temporal.PlainDate.from("2026-07-22"));
    expect(target).toEqual({ kind: "timeline", date: Temporal.PlainDate.from("2026-07-20") });
  });

  it.each(["day3", "day1"] as const)(
    "%s ビュー: クリックした日をそのまま返す(月曜揃えしない)",
    (view) => {
      const clicked = Temporal.PlainDate.from("2026-07-22");
      const target = resolveMiniMonthNavigation(view, clicked);
      expect(target).toEqual({ kind: "timeline", date: clicked });
    },
  );
});
