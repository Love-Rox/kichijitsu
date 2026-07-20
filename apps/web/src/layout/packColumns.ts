/**
 * 重なり予定の「区間グラフの列詰め」レイアウト。
 *
 * 1. 開始時刻順にソート（同時刻なら長い方を先に — 視覚的に安定する）
 * 2. 推移的に重なる予定を「クラスタ」にまとめる
 *    （クラスタ単位で幅 100% を列数で分割するため）
 * 3. クラスタ内で各予定を列に割り当てる ← assignColumns
 */

export interface Positioned<T> {
  item: T;
  /** 0-based 列番号 */
  column: number;
  /** このクラスタの総列数（幅 = 100% / columnCount） */
  columnCount: number;
}

export function packColumns<T>(
  items: readonly T[],
  getStart: (t: T) => number,
  getEnd: (t: T) => number,
): Positioned<T>[] {
  const sorted = [...items].sort((a, b) => getStart(a) - getStart(b) || getEnd(b) - getEnd(a));

  // 推移的な重なりでクラスタ分割: 走査中の最大 end を跨いだら新クラスタ
  const clusters: T[][] = [];
  let clusterEnd = -Infinity;
  for (const item of sorted) {
    if (getStart(item) >= clusterEnd || clusters.length === 0) {
      clusters.push([]);
      clusterEnd = -Infinity;
    }
    clusters[clusters.length - 1].push(item);
    clusterEnd = Math.max(clusterEnd, getEnd(item));
  }

  const out: Positioned<T>[] = [];
  for (const cluster of clusters) {
    const columns = assignColumns(cluster, getStart, getEnd);
    const columnCount = Math.max(...columns) + 1;
    cluster.forEach((item, i) => {
      out.push({ item, column: columns[i], columnCount });
    });
  }
  return out;
}

/**
 * クラスタ内の各予定に列番号を割り当てる。
 * cluster は開始時刻順にソート済み。戻り値は cluster と同じ順序の列番号配列。
 *
 * greedy first-fit: 各列の最後の予定の終了時刻を保持し、
 * 終了済み（end <= この予定の start）の列のうち最も左の列に置く。
 * 空きが無ければ新しい列を作る。Google カレンダーもほぼこの方式。
 */
function assignColumns<T>(
  cluster: readonly T[],
  getStart: (t: T) => number,
  getEnd: (t: T) => number,
): number[] {
  const columnEnds: number[] = [];
  const result: number[] = [];
  for (const item of cluster) {
    const start = getStart(item);
    let placed = false;
    for (let col = 0; col < columnEnds.length; col++) {
      if (columnEnds[col] <= start) {
        columnEnds[col] = getEnd(item);
        result.push(col);
        placed = true;
        break;
      }
    }
    if (!placed) {
      columnEnds.push(getEnd(item));
      result.push(columnEnds.length - 1);
    }
  }
  return result;
}
