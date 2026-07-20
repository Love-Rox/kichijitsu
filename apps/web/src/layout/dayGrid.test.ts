import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vite-plus/test";
import { daysFrom, panelAnchors, panelSlideDirection, stepAnchor } from "./dayGrid";

describe("daysFrom", () => {
  it("anchor を先頭に dayCount 件の連続した日付を返す(週=7)", () => {
    const days = daysFrom(Temporal.PlainDate.from("2026-07-20"), 7);
    expect(days).toHaveLength(7);
    expect(days[0].toString()).toBe("2026-07-20");
    expect(days[6].toString()).toBe("2026-07-26");
  });

  it("dayCount=3(モバイル3日タイムライン)", () => {
    const days = daysFrom(Temporal.PlainDate.from("2026-07-20"), 3);
    expect(days.map((d) => d.toString())).toEqual(["2026-07-20", "2026-07-21", "2026-07-22"]);
  });

  it("dayCount=1(モバイル1日タイムライン)", () => {
    const days = daysFrom(Temporal.PlainDate.from("2026-07-20"), 1);
    expect(days.map((d) => d.toString())).toEqual(["2026-07-20"]);
  });
});

describe("panelAnchors", () => {
  it("中央 center を挟んだ prev/current/next の3 anchor を返す", () => {
    const center = Temporal.PlainDate.from("2026-07-20");
    const [prev, cur, next] = panelAnchors(center, 7);
    expect(prev.toString()).toBe("2026-07-13");
    expect(cur.toString()).toBe("2026-07-20");
    expect(next.toString()).toBe("2026-07-27");
  });

  it("dayCount=3 でも同様に ±dayCount 日ずれる", () => {
    const center = Temporal.PlainDate.from("2026-07-20");
    const [prev, cur, next] = panelAnchors(center, 3);
    expect(prev.toString()).toBe("2026-07-17");
    expect(cur.toString()).toBe("2026-07-20");
    expect(next.toString()).toBe("2026-07-23");
  });
});

describe("stepAnchor", () => {
  it("+1 で dayCount 日後へ進む", () => {
    const anchor = Temporal.PlainDate.from("2026-07-20");
    expect(stepAnchor(anchor, 7, 1).toString()).toBe("2026-07-27");
    expect(stepAnchor(anchor, 3, 1).toString()).toBe("2026-07-23");
    expect(stepAnchor(anchor, 1, 1).toString()).toBe("2026-07-21");
  });

  it("-1 で dayCount 日前へ戻る", () => {
    const anchor = Temporal.PlainDate.from("2026-07-20");
    expect(stepAnchor(anchor, 7, -1).toString()).toBe("2026-07-13");
    expect(stepAnchor(anchor, 3, -1).toString()).toBe("2026-07-17");
    expect(stepAnchor(anchor, 1, -1).toString()).toBe("2026-07-19");
  });
});

describe("panelSlideDirection", () => {
  it("ちょうど次パネル(+dayCount日)への移動は 1", () => {
    const from = Temporal.PlainDate.from("2026-07-20");
    const to = Temporal.PlainDate.from("2026-07-27");
    expect(panelSlideDirection(from, to, 7)).toBe(1);
  });

  it("ちょうど前パネル(-dayCount日)への移動は -1", () => {
    const from = Temporal.PlainDate.from("2026-07-20");
    const to = Temporal.PlainDate.from("2026-07-13");
    expect(panelSlideDirection(from, to, 7)).toBe(-1);
  });

  it("dayCount 以外の移動(today ジャンプ等)は 0", () => {
    const from = Temporal.PlainDate.from("2026-07-20");
    const to = Temporal.PlainDate.from("2026-08-01");
    expect(panelSlideDirection(from, to, 7)).toBe(0);
  });

  it("移動なし(同日)は 0", () => {
    const d = Temporal.PlainDate.from("2026-07-20");
    expect(panelSlideDirection(d, d, 7)).toBe(0);
  });

  it("dayCount=3 で正しく1パネルぶんの移動を検出する", () => {
    const from = Temporal.PlainDate.from("2026-07-20");
    const to = Temporal.PlainDate.from("2026-07-23");
    expect(panelSlideDirection(from, to, 3)).toBe(1);
    // dayCount=7 の判定には合致しない(3日ぶんの移動なので)
    expect(panelSlideDirection(from, to, 7)).toBe(0);
  });
});
