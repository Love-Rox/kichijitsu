/**
 * 終日レーンの区間パッキング(packColumns の日単位版、フェーズ5)。
 *
 * packColumns は「重なるものだけをクラスタにまとめ、クラスタ内で列幅を等分する」
 * 時刻グリッド用のレイアウトだが、終日レーンは Google カレンダーの月表示と同様に
 * 「日をまたぐ横バーを、重ならない範囲でできるだけ上の行に詰める」ガントチャート
 * 型のレイアウトになる。クラスタ分割は不要(週全体で共通の行に詰めればよい)ため、
 * より単純な greedy first-fit だけで済む。
 */

export interface DayBarPosition<T> {
  item: T
  /** 0-based 行番号。値が大きいほど下の行 */
  row: number
}

/**
 * items を日インデックス区間 [getStartDayIndex, getEndDayIndex] (両端 inclusive) で
 * 行に詰める。同じ行に置けるのは日範囲が重ならないものだけ(隣接日は重ならない扱い、
 * 例: 1件目が day 2 で終わり、2件目が day 3 から始まるなら同じ行に置ける)。
 *
 * 開始日が早い順、同じなら長い(終了日が遅い)ものを先に決定的にソートしてから
 * 各行の「その行の最後の予定の終了日」を追跡し、開始日がそれより後ろなら
 * 最も上(=最小番号)の空き行に置く。空きが無ければ新しい行を追加する
 * (packColumns の assignColumns と同じ greedy first-fit 方式)。
 */
export function packDayBars<T>(
  items: readonly T[],
  getStartDayIndex: (t: T) => number,
  getEndDayIndex: (t: T) => number,
): DayBarPosition<T>[] {
  const sorted = [...items].sort(
    (a, b) => getStartDayIndex(a) - getStartDayIndex(b) || getEndDayIndex(b) - getEndDayIndex(a),
  )

  const rowEnds: number[] = []
  const result: DayBarPosition<T>[] = []
  for (const item of sorted) {
    const start = getStartDayIndex(item)
    const end = getEndDayIndex(item)
    let placed = false
    for (let row = 0; row < rowEnds.length; row++) {
      if (rowEnds[row] < start) {
        rowEnds[row] = end
        result.push({ item, row })
        placed = true
        break
      }
    }
    if (!placed) {
      rowEnds.push(end)
      result.push({ item, row: rowEnds.length - 1 })
    }
  }
  return result
}
