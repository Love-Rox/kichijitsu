import { Temporal } from '@js-temporal/polyfill'

/**
 * 週グリッド(WeekGrid.tsx)を「表示日数 N 可変の N 日タイムライン」として扱うための
 * 純関数群(モバイル対応フェーズ2、docs/multiplatform.md)。N=7 なら従来の週ビュー、
 * N=3/1 ならモバイルの3日/1日タイムラインになる。DOM/React に依存しないため
 * WeekGrid.tsx から呼ばれる薄いロジック層としてここに切り出し、単体テストしやすくしてある
 * (gridMetrics.ts/monthGrid.ts と同じ流儀)。
 */

/** anchor を含む N 日ぶんの日付を先頭から並べて返す(anchor が先頭日) */
export function daysFrom(anchor: Temporal.PlainDate, dayCount: number): Temporal.PlainDate[] {
  return Array.from({ length: dayCount }, (_, i) => anchor.add({ days: i }))
}

/**
 * WeekGrid のストリップ(prev/current/next の3パネル)が指す3つの anchor 日。
 * 中央(index 1)が現在表示中のパネルの先頭日。
 */
export function panelAnchors(center: Temporal.PlainDate, dayCount: number): Temporal.PlainDate[] {
  return [center.subtract({ days: dayCount }), center, center.add({ days: dayCount })]
}

/** N 日送り/戻し。方向は +1(次) / -1(前) */
export function stepAnchor(
  anchor: Temporal.PlainDate,
  dayCount: number,
  direction: 1 | -1,
): Temporal.PlainDate {
  return direction === 1 ? anchor.add({ days: dayCount }) : anchor.subtract({ days: dayCount })
}

/**
 * center から見て、次の(または前の)ぴったり1パネルぶん(=dayCount 日)だけ移動したか。
 * WeekGrid のスライドアニメーション要否判定(隣パネルへのちょうどの移動かどうか)に使う。
 * 戻り値: 1=次パネルへの移動, -1=前パネルへの移動, 0=それ以外(today ジャンプ等、瞬時切り替え)
 */
export function panelSlideDirection(
  from: Temporal.PlainDate,
  to: Temporal.PlainDate,
  dayCount: number,
): 1 | -1 | 0 {
  const deltaDays = to.since(from, { largestUnit: 'day' }).days
  if (deltaDays === dayCount) return 1
  if (deltaDays === -dayCount) return -1
  return 0
}
