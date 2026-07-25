import { describe, expect, it } from "vite-plus/test";
import { Temporal } from "@js-temporal/polyfill";
import { dayCountForView, initialTimelineStart, isView, timelineRangeMs } from "./viewRange";

describe("isView", () => {
  it("既知の4つだけを View とみなす", () => {
    expect(isView("week")).toBe(true);
    expect(isView("month")).toBe(true);
    expect(isView("day3")).toBe(true);
    expect(isView("day1")).toBe(true);
  });

  it("未知の文字列・空文字は View ではない(壊れた localStorage 値の防波堤)", () => {
    expect(isView("")).toBe(false);
    expect(isView("day2")).toBe(false);
    expect(isView("Week")).toBe(false);
  });
});

describe("dayCountForView", () => {
  it("week=7 / day3=3 / day1=1", () => {
    expect(dayCountForView("week")).toBe(7);
    expect(dayCountForView("day3")).toBe(3);
    expect(dayCountForView("day1")).toBe(1);
  });

  it("month は WeekGrid を使わないため 0", () => {
    expect(dayCountForView("month")).toBe(0);
  });
});

describe("initialTimelineStart", () => {
  // 2026-07-23 は木曜。週の後半に開いたケースを固定日で再現する
  const thursday = Temporal.PlainDate.from("2026-07-23");

  it("week はその週の月曜を先頭日にする", () => {
    expect(initialTimelineStart("week", thursday).toString()).toBe("2026-07-20");
  });

  it("day3/day1 は今日そのものを先頭日にする(過去の日しか見えなくならないように)", () => {
    expect(initialTimelineStart("day3", thursday).toString()).toBe("2026-07-23");
    expect(initialTimelineStart("day1", thursday).toString()).toBe("2026-07-23");
  });

  it("月曜に開いた week は月曜のまま", () => {
    const monday = Temporal.PlainDate.from("2026-07-20");
    expect(initialTimelineStart("week", monday).toString()).toBe("2026-07-20");
  });
});

describe("timelineRangeMs", () => {
  const start = Temporal.PlainDate.from("2026-07-20");

  it("[start, start+dayCount日) の半開区間を timeZone の壁時計基準で返す", () => {
    const { fromMs, toMs } = timelineRangeMs(start, 7, "UTC");
    expect(fromMs).toBe(Date.UTC(2026, 6, 20));
    expect(toMs).toBe(Date.UTC(2026, 6, 27));
  });

  it("dayCount がそのまま日数として効く(day3 / day1)", () => {
    expect(timelineRangeMs(start, 3, "UTC").toMs).toBe(Date.UTC(2026, 6, 23));
    expect(timelineRangeMs(start, 1, "UTC").toMs).toBe(Date.UTC(2026, 6, 21));
  });

  it("timeZone のオフセットを反映する(Asia/Tokyo は UTC より9時間早い)", () => {
    const { fromMs, toMs } = timelineRangeMs(start, 1, "Asia/Tokyo");
    expect(fromMs).toBe(Date.UTC(2026, 6, 19, 15));
    expect(toMs - fromMs).toBe(24 * 60 * 60_000);
  });
});
