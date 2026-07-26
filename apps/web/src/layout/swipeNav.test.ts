import { describe, expect, it } from "vite-plus/test";
import {
  classifySwipeAxis,
  computeTrailingVelocity,
  resolveSwipeDays,
  SWIPE_DIRECTION_DOMINANCE,
  SWIPE_DIRECTION_MIN_PX,
  SWIPE_VERTICAL_SLOP_PX,
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
    // adx === ady * dominance のとき、adx > ady*dominance は false。
    // 縦成分が slop(8px)以下の領域で緩い dominance(1.25)が効くことも同時に確認する
    const boundary = SWIPE_VERTICAL_SLOP_PX * SWIPE_DIRECTION_DOMINANCE; // = 10
    expect(
      classifySwipeAxis(boundary, SWIPE_VERTICAL_SLOP_PX, SWIPE_DIRECTION_MIN_PX, undefined),
    ).toBe("vertical");
    expect(
      classifySwipeAxis(boundary + 0.01, SWIPE_VERTICAL_SLOP_PX, SWIPE_DIRECTION_MIN_PX, undefined),
    ).toBe("horizontal");
  });

  it("片方の軸だけ大きく動いた場合(閾値超え済み)も dx/dy 比較だけで判定する", () => {
    // ady が slop を超えていても、adx がさらに strict dominance(2.5)倍優勢なら horizontal
    expect(classifySwipeAxis(40, 12)).toBe("horizontal");
  });

  // M-7(2026-07-25): 斜めスワイプの二重挙動対策。縦成分が touch slop を超えてからの
  // 横確定には strict dominance を要求する ―― 詳細は swipeNav.ts のコメント参照
  it("縦成分が slop 以下なら緩い dominance で横に入れる(通常の横スワイプは従来どおり)", () => {
    expect(classifySwipeAxis(15, SWIPE_VERTICAL_SLOP_PX)).toBe("horizontal"); // 15 > 8*1.25=10
    expect(classifySwipeAxis(20, 0)).toBe("horizontal");
  });

  it("縦成分が slop を超えた斜めスワイプは横に入らない(既に縦スクロールが始まっている)", () => {
    // レビュー指摘の再現ケース: dx=20 / dy=12 は 1.25 倍だと horizontal だが、
    // 20 > 12*2.0 = 24 は満たさないので vertical(縦へ委ねる)
    expect(classifySwipeAxis(20, 12)).toBe("vertical");
    expect(classifySwipeAxis(-20, 12)).toBe("vertical");
    expect(classifySwipeAxis(24, 12)).toBe("vertical"); // ちょうど strict 倍も vertical(> 判定)
  });

  // 2026-07-26: strict を 2.5 → 2.0 に緩和。親指の弧で dy が slop を少し超えた程度の
  // 「明確に横」なスワイプが無反応になるのを減らす(M-7 の再現ケースは上のとおり据え置き)
  it("縦成分が slop を超えていても、明確に横なら horizontal(親指の弧を拾う)", () => {
    expect(classifySwipeAxis(30, 12)).toBe("horizontal"); // 30 > 12*2.0 = 24
    expect(classifySwipeAxis(-30, -12)).toBe("horizontal");
  });

  it("縦成分があっても圧倒的に横なら horizontal(速い横フリックを取りこぼさない)", () => {
    // 1イベントで dx=60/dy=15 のような粗いサンプルで届く速いフリックは救う
    expect(classifySwipeAxis(60, 15)).toBe("horizontal");
    expect(classifySwipeAxis(-60, -15)).toBe("horizontal");
  });

  it("strict dominance は引数で上書きできる(将来のチューニング用)", () => {
    expect(
      classifySwipeAxis(20, 12, SWIPE_DIRECTION_MIN_PX, undefined, SWIPE_VERTICAL_SLOP_PX, 1.25),
    ).toBe("horizontal");
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

describe("resolveSwipeDays", () => {
  // 3日ビュー相当: パネル幅 390px / dayCount 3 → 1日カラム = 130px
  const dayWidthPx = 130;
  const maxDays = 3;
  const base = { dayWidthPx, maxDays, velocityPxPerMs: 0 };

  // 符号の約束: 指を右へ(dxPx>0)= 前の日が覗く = timelineStart は過去へ(負)
  it("指を離した位置に最も近い日へ丸める(0.5日が境界)", () => {
    expect(resolveSwipeDays({ ...base, dxPx: -0.4 * dayWidthPx })).toBe(0); // 0.4日 → stay
    expect(resolveSwipeDays({ ...base, dxPx: -0.6 * dayWidthPx })).toBe(1); // 0.6日 → 1日先へ
    expect(resolveSwipeDays({ ...base, dxPx: -1.4 * dayWidthPx })).toBe(1); // 1.4日 → まだ1日
    expect(resolveSwipeDays({ ...base, dxPx: -1.6 * dayWidthPx })).toBe(2); // 1.6日 → 2日先へ
  });

  it("符号: 指を右へ動かすと過去(負)、左へ動かすと未来(正)", () => {
    expect(resolveSwipeDays({ ...base, dxPx: 0.6 * dayWidthPx })).toBe(-1);
    expect(resolveSwipeDays({ ...base, dxPx: 1.6 * dayWidthPx })).toBe(-2);
    expect(resolveSwipeDays({ ...base, dxPx: -0.6 * dayWidthPx })).toBe(1);
  });

  it("回帰防止: 1日固定ではなく、動かした量ぶん進む(旧 resolveSwipeOutcome の「戻される」症状)", () => {
    // 旧実装は 1.5日ぶん動かしても必ず1日しか進まず、strip が指より手前へ戻っていた
    expect(resolveSwipeDays({ ...base, dxPx: -2.2 * dayWidthPx })).toBe(2);
    expect(resolveSwipeDays({ ...base, dxPx: -2.6 * dayWidthPx })).toBe(3);
  });

  it("丸めて0日でも、フリック(速度が閾値超え)なら速度の向きへ最低1日進む", () => {
    // 20px(0.15日)しか動かしていないが、左へ速く振り抜いた → 1日先へ
    expect(resolveSwipeDays({ ...base, dxPx: -20, velocityPxPerMs: -0.8 })).toBe(1);
    expect(resolveSwipeDays({ ...base, dxPx: 20, velocityPxPerMs: 0.8 })).toBe(-1);
    // 閾値ちょうど(0.3)は超えていないので、慣性ぶんを足しても丸めが0なら stay のまま
    expect(resolveSwipeDays({ ...base, dxPx: -5, velocityPxPerMs: -0.3 })).toBe(0);
  });

  it("勢いは慣性として移動量に上乗せされる(強いフリックは2日以上届く)", () => {
    // 1.2日ぶん(156px)を 1.5px/ms で振り抜き → +120px(0.92日)= 2.12日 → 2日
    expect(resolveSwipeDays({ ...base, dxPx: -1.2 * dayWidthPx, velocityPxPerMs: -1.5 })).toBe(2);
    // 同じ移動量でも指を止めて離せば(速度0)1日のまま
    expect(resolveSwipeDays({ ...base, dxPx: -1.2 * dayWidthPx })).toBe(1);
  });

  it("maxDays でクランプする(WeekGrid のレンダー済み3パネルを超えない)", () => {
    expect(resolveSwipeDays({ ...base, dxPx: -10 * dayWidthPx })).toBe(maxDays);
    expect(resolveSwipeDays({ ...base, dxPx: 10 * dayWidthPx })).toBe(-maxDays);
    // day1 ビュー(dayCount=1)は1日までしか送れない
    expect(
      resolveSwipeDays({ dayWidthPx, maxDays: 1, velocityPxPerMs: 0, dxPx: -5 * dayWidthPx }),
    ).toBe(1);
  });

  it("dayWidthPx が 0 以下(未測定の保険)/ maxDays が 1 未満なら常に 0", () => {
    expect(resolveSwipeDays({ dxPx: -300, dayWidthPx: 0, maxDays, velocityPxPerMs: 5 })).toBe(0);
    expect(resolveSwipeDays({ dxPx: -300, dayWidthPx: -10, maxDays, velocityPxPerMs: 5 })).toBe(0);
    expect(resolveSwipeDays({ dxPx: -300, dayWidthPx, maxDays: 0, velocityPxPerMs: 5 })).toBe(0);
  });

  it("まったく動いていなければ 0", () => {
    expect(resolveSwipeDays({ ...base, dxPx: 0 })).toBe(0);
    expect(resolveSwipeDays({ ...base, dxPx: -5, velocityPxPerMs: -0.01 })).toBe(0);
  });

  it("flickVelocityPxPerMs / flickProjectionMs を上書きできる", () => {
    expect(
      resolveSwipeDays({ ...base, dxPx: -5, velocityPxPerMs: -0.2, flickVelocityPxPerMs: 0.1 }),
    ).toBe(1);
    // 慣性を切れば(0ms)、素の移動量だけで丸める
    expect(
      resolveSwipeDays({
        ...base,
        dxPx: -1.2 * dayWidthPx,
        velocityPxPerMs: -1.5,
        flickProjectionMs: 0,
      }),
    ).toBe(1);
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
