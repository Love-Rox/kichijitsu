import { describe, expect, it } from "vite-plus/test";
import {
  classifySwipeAxis,
  resolveSwipeOutcome,
  SWIPE_DIRECTION_DOMINANCE,
  SWIPE_DIRECTION_MIN_PX,
  swipeStripTransform,
} from "./swipeNav";

describe("classifySwipeAxis", () => {
  it("両軸とも閾値未満なら pending(判定保留、他ジェスチャに介入しない)", () => {
    expect(classifySwipeAxis(3, 2)).toBe("pending");
    expect(classifySwipeAxis(0, 0)).toBe("pending");
    // 閾値ちょうど未満の境界
    expect(classifySwipeAxis(SWIPE_DIRECTION_MIN_PX - 1, 0)).toBe("pending");
  });

  it("横方向が dominance 倍を超えて優勢なら horizontal", () => {
    expect(classifySwipeAxis(20, 5)).toBe("horizontal");
    // 符号は問わない(左スワイプも同様に判定できる)
    expect(classifySwipeAxis(-20, -5)).toBe("horizontal");
  });

  it("縦方向が優勢、または横が明確でなければ vertical(縦スクロール等に委ねる)", () => {
    expect(classifySwipeAxis(5, 20)).toBe("vertical");
    // dx・dy が拮抗(dominance を超えない)なら vertical 側に倒す(安全側)
    expect(classifySwipeAxis(12, 10)).toBe("vertical");
  });

  it("dominance 境界: ちょうど比率と同じなら horizontal ではない(> であって >= ではない)", () => {
    // adx === ady * dominance のとき、adx > ady*dominance は false
    expect(classifySwipeAxis(15, 10, SWIPE_DIRECTION_MIN_PX, SWIPE_DIRECTION_DOMINANCE)).toBe(
      "vertical",
    );
    expect(classifySwipeAxis(15.01, 10, SWIPE_DIRECTION_MIN_PX, SWIPE_DIRECTION_DOMINANCE)).toBe(
      "horizontal",
    );
  });

  it("片方の軸だけ大きく動いた場合(閾値超え済み)も dx/dy 比較だけで判定する", () => {
    // ady が既に閾値を超えていても、adx がさらに dominance 倍優勢なら horizontal
    expect(classifySwipeAxis(40, 12)).toBe("horizontal");
  });
});

describe("swipeStripTransform", () => {
  it("dxPx が 0 のときは calc を使わず素の translateX(基準%) を返す", () => {
    expect(swipeStripTransform(-33.3333, 0)).toBe("translateX(-33.3333%)");
    expect(swipeStripTransform(0, 0)).toBe("translateX(0%)");
  });

  it("dxPx が非0のとき、基準%に px オフセットを足した calc() を返す", () => {
    expect(swipeStripTransform(-33.3333, -120)).toBe("translateX(calc(-33.3333% + -120px))");
    expect(swipeStripTransform(-33.3333, 80)).toBe("translateX(calc(-33.3333% + 80px))");
  });

  it("prev/next の基準%でも同じ形で組み立つ", () => {
    expect(swipeStripTransform(0, 40)).toBe("translateX(calc(0% + 40px))");
    expect(swipeStripTransform(-66.6667, -10)).toBe("translateX(calc(-66.6667% + -10px))");
  });
});

describe("resolveSwipeOutcome", () => {
  const panelWidthPx = 400;

  it("移動量がパネル幅の25%を超えたら確定する(遅いドラッグでもOK)", () => {
    expect(resolveSwipeOutcome({ dxPx: -101, panelWidthPx, velocityPxPerMs: 0 })).toBe("next");
    expect(resolveSwipeOutcome({ dxPx: 101, panelWidthPx, velocityPxPerMs: 0 })).toBe("prev");
  });

  it("移動量が25%ちょうど・未満なら stay(> であって >= ではない)", () => {
    expect(resolveSwipeOutcome({ dxPx: 100, panelWidthPx, velocityPxPerMs: 0 })).toBe("stay");
    expect(resolveSwipeOutcome({ dxPx: 50, panelWidthPx, velocityPxPerMs: 0 })).toBe("stay");
  });

  it("移動量は閾値未満でもフリック(速い離し)なら確定する", () => {
    expect(resolveSwipeOutcome({ dxPx: -20, panelWidthPx, velocityPxPerMs: -0.8 })).toBe("next");
    expect(resolveSwipeOutcome({ dxPx: 20, panelWidthPx, velocityPxPerMs: 0.8 })).toBe("prev");
  });

  it("フリック速度が閾値ちょうど・未満なら移動量条件と合わせて判定する(単独では確定しない)", () => {
    expect(resolveSwipeOutcome({ dxPx: 20, panelWidthPx, velocityPxPerMs: 0.5 })).toBe("stay");
  });

  it("移動量・速度ともに閾値未満なら stay", () => {
    expect(resolveSwipeOutcome({ dxPx: 5, panelWidthPx, velocityPxPerMs: 0.01 })).toBe("stay");
  });

  it("panelWidthPx が 0 以下(未測定の保険)なら常に stay", () => {
    expect(resolveSwipeOutcome({ dxPx: 300, panelWidthPx: 0, velocityPxPerMs: 5 })).toBe("stay");
    expect(resolveSwipeOutcome({ dxPx: 300, panelWidthPx: -10, velocityPxPerMs: 5 })).toBe("stay");
  });

  it("distanceRatio/flickVelocityPxPerMs を上書きできる", () => {
    expect(
      resolveSwipeOutcome({
        dxPx: -60,
        panelWidthPx,
        velocityPxPerMs: 0,
        distanceRatio: 0.1,
      }),
    ).toBe("next");
    expect(
      resolveSwipeOutcome({
        dxPx: 5,
        panelWidthPx,
        velocityPxPerMs: 0.2,
        flickVelocityPxPerMs: 0.1,
      }),
    ).toBe("prev");
  });
});
