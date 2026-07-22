/**
 * スマホでのスワイプ日付移動(モバイル対応フェーズ2 増分、2026-07-22)の純ロジック。
 * WeekGrid.tsx の3パネルストリップ(prev/current/next、`stripStyle` の translateX で
 * 横スライドする既存構造、dayGrid.ts の panelAnchors/panelSlideDirection と対になる)を
 * 指に追従させ、離した時に「前/次へ確定」か「元に戻す」かを決めるための計算だけを
 * DOM/React から切り離してここに置く(dayGrid.ts と同じ流儀)。
 *
 * ジェスチャの実 DOM 配線(pointerdown/move/up の購読、setPointerCapture 等)は
 * hooks/useSwipeNavigation.ts が担い、判定・数値計算はすべてここへ委譲する。
 */

/** 「横方向が支配的」と確定するまでの最小移動量(px)。ごく僅かな指のブレでは反応しない */
export const SWIPE_DIRECTION_MIN_PX = 10;
/** |dx| が |dy| のこの倍数を超えたら横方向優勢、そうでなければ縦方向(スクロール等)優勢とみなす。
 * スマホの親指スワイプは弧を描いて縦成分が乗りやすいため、やや緩め(1.25)にして「横に振ったのに
 * 縦扱いで反応しない」を減らす ―― 縦スクロールは |dy| が圧倒的に大きく、この値でも安全に vertical へ倒れる */
export const SWIPE_DIRECTION_DOMINANCE = 1.25;
/** 指を離した時、パネル幅に対してこの割合を超えて動いていれば前/次へ確定する(18%)。
 * 25% は「引ききらないと戻される」体感が強かったため緩和(スムーズさ優先、2026-07-22) */
export const SWIPE_SNAP_DISTANCE_RATIO = 0.18;
/** フリックとみなす速度の閾値(px/ms)。0.3px/ms ≒ 300px/s ―― 移動量が閾値未満でも
 * これを超える速さで離せば前/次へ確定する(要件の「フリック速度」対応)。軽いフリックでも
 * 効くよう 0.5→0.3 に緩和(2026-07-22) */
export const SWIPE_FLICK_VELOCITY_PX_PER_MS = 0.3;
/** フリック速度を「直近何ミリ秒ぶんのサンプルで測るか」のウィンドウ幅。pointerup 直前の
 * 1サンプルだけだと、指を止めてから離したときに速度 0 と誤検出されフリックが効かないため、
 * この時間窓の端点差分で平均速度を出す(computeTrailingVelocity 参照) */
export const SWIPE_VELOCITY_WINDOW_MS = 100;

export type SwipeAxis = "pending" | "horizontal" | "vertical";

/**
 * touchstart(pointerdown)からの累積移動量 (dx, dy) を見て、このジェスチャが
 * 「日付ナビ用の横スワイプ」なのか「縦スクロール/その他(イベントドラッグ・新規作成)に
 * 委ねるべき」なのかを判定する。
 *
 * - "pending": まだ両軸とも移動量が閾値未満 ―― 判定を保留し、次の pointermove を待つ
 *   (呼び出し側はまだ何もせず、既存のイベントドラッグ/新規作成/スクロールにも介入しない)。
 * - "horizontal": |dx| が |dy| の SWIPE_DIRECTION_DOMINANCE 倍を超えた ―― 横スワイプ確定。
 *   呼び出し側はここで初めて transform 追従を始めてよい。
 * - "vertical": 横方向が優勢でない(縦優勢、または閾値は超えたが横が明確でない) ―― 従来通り
 *   (縦スクロール・イベントドラッグ・新規作成)に委ねるべきサイン。
 */
/** フリック速度算出用の1サンプル(pointermove/up 時のクライアント X 座標と時刻) */
export interface SwipeSample {
  x: number;
  time: number;
}

/**
 * 直近 windowMs ミリ秒ぶんのサンプルから、水平方向の平均速度(px/ms)を求める。
 * pointerup 直前の1区間だけを見ると、指を止めてから離した場合に速度が 0 と誤検出され
 * フリックが実質効かなくなる(旧実装の症状)。そこで「最新サンプルから windowMs 以内に
 * 収まる最古サンプル」との端点差分で平均速度を出し、離す直前の勢いを安定して拾う。
 *
 * samples は時刻昇順(古い→新しい)を前提。2点未満、または端点の時間差が無いときは 0。
 */
export function computeTrailingVelocity(
  samples: readonly SwipeSample[],
  windowMs: number = SWIPE_VELOCITY_WINDOW_MS,
): number {
  if (samples.length < 2) return 0;
  const newest = samples[samples.length - 1];
  let oldest = newest;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (newest.time - samples[i].time <= windowMs) {
      oldest = samples[i];
    } else {
      break; // それ以上遡ると窓の外(samples は昇順なので以降も全て窓外)
    }
  }
  const dt = newest.time - oldest.time;
  if (dt <= 0) return 0;
  return (newest.x - oldest.x) / dt;
}

export function classifySwipeAxis(
  dx: number,
  dy: number,
  minPx: number = SWIPE_DIRECTION_MIN_PX,
  dominance: number = SWIPE_DIRECTION_DOMINANCE,
): SwipeAxis {
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx < minPx && ady < minPx) return "pending";
  return adx > ady * dominance ? "horizontal" : "vertical";
}

/**
 * 横スワイプ確定中、指に追従させる strip の transform 文字列を作る。
 * basePercent は現在の phase(prev/idle/next)が指す translateX の基準値(%、WeekGrid.tsx の
 * PHASE_BASE_PERCENT)、dxPx は pointerdown からの指の水平移動量(px)。
 * calc() で % と px を混在させることで、パネル幅を px で計算し直す必要なく
 * そのまま「基準位置 + 指の移動量」を表現できる。
 */
export function swipeStripTransform(basePercent: number, dxPx: number): string {
  if (dxPx === 0) return `translateX(${basePercent}%)`;
  return `translateX(calc(${basePercent}% + ${dxPx}px))`;
}

export type SwipeOutcome = "prev" | "next" | "stay";

export interface ResolveSwipeOutcomeParams {
  /** pointerdown からの水平方向の累積移動量(px)。正=右(指を右へ)、負=左 */
  dxPx: number;
  /** 1パネルぶんの表示幅(px)。0 以下なら常に "stay"(測定できていない異常系の保険) */
  panelWidthPx: number;
  /** 直近の pointermove サンプル間の速度(px/ms)。フリック判定に使う */
  velocityPxPerMs: number;
  /** スナップ確定に必要な、パネル幅に対する移動量の割合(既定 25%) */
  distanceRatio?: number;
  /** フリックとみなす速度閾値(px/ms、既定 0.5) */
  flickVelocityPxPerMs?: number;
}

/**
 * pointerup(指を離した瞬間)の移動量・速度から、日付ナビを確定するかを決める。
 * 「移動量がパネル幅の25%を超えた」または「フリック(速い離し)」のどちらかを満たせば
 * 確定し、方向は実際の正味の移動量(dxPx)の符号で決める ―― 指を右へ動かした(dx>0)ときは
 * ストリップの見た目が右へ寄る(=前のパネルが覗く)ので "prev"、逆(dx<0)は "next"
 * (WeekGrid.tsx の panelForPhase/transformForPhase の符号と対応)。
 * どちらの条件も満たさなければ "stay"(元の位置へ戻すだけ)。
 */
export function resolveSwipeOutcome({
  dxPx,
  panelWidthPx,
  velocityPxPerMs,
  distanceRatio = SWIPE_SNAP_DISTANCE_RATIO,
  flickVelocityPxPerMs = SWIPE_FLICK_VELOCITY_PX_PER_MS,
}: ResolveSwipeOutcomeParams): SwipeOutcome {
  if (panelWidthPx <= 0) return "stay";
  const passedDistance = Math.abs(dxPx) > panelWidthPx * distanceRatio;
  const passedFlick = Math.abs(velocityPxPerMs) > flickVelocityPxPerMs;
  if (!passedDistance && !passedFlick) return "stay";
  if (dxPx === 0) return "stay"; // 理論上到達しない保険(速度だけ閾値越えで移動量ゼロは無い)
  return dxPx > 0 ? "prev" : "next";
}
