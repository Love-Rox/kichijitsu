import { minutesToPx } from "./gridMetrics";

/** 現在時刻が見えないときの基準(朝8時を上端に置く) */
export const INITIAL_SCROLL_HOUR = 8;

/**
 * ページを開いたときの初期 scrollTop(px)。
 *
 * - 基準は朝8時を上端に置く位置。今日が表示範囲に無い(nowMinutes が null)ときはこれ。
 * - 8時基準のままで現在時刻が(上下に少し余白を残して)見えるなら、基準を動かさない。
 * - 見えない(早朝・夜・縮小時など)ときは、現在時刻がビューポートの上から 1/3 に来るように動かす。
 *   範囲外は scrollTo 側が丸めるので、ここでは下限(0)だけ守る。
 *
 * @param nowMinutes 表示タイムゾーンでの現在時刻(0〜1439)。今日が表示範囲に無ければ null
 */
export function initialScrollTop(
  nowMinutes: number | null,
  hourHeight: number,
  viewportHeight: number,
): number {
  const base = minutesToPx(INITIAL_SCROLL_HOUR * 60, hourHeight);
  if (nowMinutes === null || viewportHeight <= 0) return base;
  const nowPx = minutesToPx(nowMinutes, hourHeight);
  const margin = Math.max(24, viewportHeight * 0.1);
  if (nowPx >= base + margin && nowPx <= base + viewportHeight - margin) return base;
  return Math.max(0, nowPx - viewportHeight / 3);
}
