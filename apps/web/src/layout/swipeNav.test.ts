import { describe, expect, it } from "vite-plus/test";
import {
  classifySwipeAxis,
  computeTrailingVelocity,
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
    // dx・dy が拮抗(dominance=1.25 を超えない)なら vertical 側に倒す(安全側)
    expect(classifySwipeAxis(12, 10)).toBe("vertical");
  });

  it("dominance 境界: ちょうど比率と同じなら horizontal ではない(> であって >= ではない)", () => {
    // adx === ady * dominance(1.25)のとき、adx > ady*dominance は false
    const boundary = 10 * SWIPE_DIRECTION_DOMINANCE; // = 12.5
    expect(classifySwipeAxis(boundary, 10, SWIPE_DIRECTION_MIN_PX, SWIPE_DIRECTION_DOMINANCE)).toBe(
      "vertical",
    );
    expect(
      classifySwipeAxis(boundary + 0.01, 10, SWIPE_DIRECTION_MIN_PX, SWIPE_DIRECTION_DOMINANCE),
    ).toBe("horizontal");
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
  // 既定 distanceRatio=0.18 → 閾値 400*0.18 = 72px

  it("移動量がパネル幅の18%を超えたら確定する(遅いドラッグでもOK)", () => {
    expect(resolveSwipeOutcome({ dxPx: -73, panelWidthPx, velocityPxPerMs: 0 })).toBe("next");
    expect(resolveSwipeOutcome({ dxPx: 73, panelWidthPx, velocityPxPerMs: 0 })).toBe("prev");
  });

  it("移動量が18%ちょうど・未満なら stay(> であって >= ではない)", () => {
    expect(resolveSwipeOutcome({ dxPx: 72, panelWidthPx, velocityPxPerMs: 0 })).toBe("stay");
    expect(resolveSwipeOutcome({ dxPx: 40, panelWidthPx, velocityPxPerMs: 0 })).toBe("stay");
  });

  it("移動量は閾値未満でもフリック(速い離し)なら確定する", () => {
    expect(resolveSwipeOutcome({ dxPx: -20, panelWidthPx, velocityPxPerMs: -0.8 })).toBe("next");
    expect(resolveSwipeOutcome({ dxPx: 20, panelWidthPx, velocityPxPerMs: 0.8 })).toBe("prev");
  });

  it("フリック速度が閾値(0.3)ちょうど・未満なら移動量条件と合わせて判定する(単独では確定しない)", () => {
    expect(resolveSwipeOutcome({ dxPx: 20, panelWidthPx, velocityPxPerMs: 0.3 })).toBe("stay");
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

describe("computeTrailingVelocity", () => {
  it("サンプルが2点未満なら 0(速度を測れない)", () => {
    expect(computeTrailingVelocity([])).toBe(0);
    expect(computeTrailingVelocity([{ x: 10, time: 0 }])).toBe(0);
  });

  it("時間窓内の端点差分から平均速度(px/ms)を出す", () => {
    // 0ms→100ms で 0px→50px 移動 = 0.5px/ms
    expect(
      computeTrailingVelocity([
        { x: 0, time: 0 },
        { x: 50, time: 100 },
      ]),
    ).toBeCloseTo(0.5);
  });

  it("窓(既定100ms)より古いサンプルは無視し、離す直前の勢いだけを見る", () => {
    // 最新は time=200。time=0 は 200-0=200ms 前で窓外。窓内(<=100ms)の最古は time=120(x=5)。
    // 序盤に長く止まっていた(0..120 でほぼ動かず)としても、端点は time=120→200 の 80ms で
    // x=5→200 = 195px 移動 → 195/80px/ms を返す(古い停滞に引きずられない)。
    const v = computeTrailingVelocity([
      { x: 0, time: 0 },
      { x: 5, time: 120 },
      { x: 200, time: 200 },
    ]);
    expect(v).toBeCloseTo(195 / 80);
  });

  it("指を止めてから離した場合でも、窓内に動きがあれば拾う(旧実装で 0 になっていた症状の回帰防止)", () => {
    // 直近2点が同座標(離す瞬間に静止)でも、窓内のもっと前のサンプルとの差分で速度が出る
    const v = computeTrailingVelocity([
      { x: 0, time: 0 },
      { x: 80, time: 60 },
      { x: 80, time: 90 }, // 離す直前は静止(旧実装だとここだけ見て 0)
    ]);
    expect(v).toBeCloseTo(80 / 90);
  });

  it("端点の時間差が無い(全サンプル同時刻)なら 0(0除算回避)", () => {
    expect(
      computeTrailingVelocity([
        { x: 0, time: 50 },
        { x: 30, time: 50 },
      ]),
    ).toBe(0);
  });
});
