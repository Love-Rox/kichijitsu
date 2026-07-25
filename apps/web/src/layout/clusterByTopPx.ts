import { msToTopPx } from "./gridMetrics";

/**
 * 日列端レール(commit 実績 / CI 実行)の「近接タイムスタンプを1点にまとめる」クラスタリングの
 * generic 層(2026-07-26 リファクタ フェーズ3a)。
 *
 * なぜ generic にしたか: sync/mapActivity.ts の layoutDayActivity と sync/mapCiRuns.ts の
 * layoutDayCiRuns は、両ファイルのコメントが自認していたとおり行単位で同一だった(半開区間での
 * 日別フィルタ → timestampMs 昇順ソート → アンカー基準のしきい値クラスタリング)。DTO の型しか
 * 違わないためここに1本化し、両者は型を当てるだけのラッパーになっている ―― 「しきい値を変える」
 * 「境界の扱いを直す」といった変更が片方だけに入る事故を構造的に防ぐのが目的。
 */

/** 近接タイムスタンプの items をまとめたクラスタ */
export interface TopPxCluster<T> {
  /** msToTopPx(anchorMs, dayStartMs, hourHeight) の結果。クラスタの代表位置(先頭アイテムの位置) */
  topPx: number;
  /** クラスタに属する items。timestampMs 昇順 */
  items: T[];
  /** items.length のショートカット(呼び出し側の可読性のため) */
  count: number;
}

/**
 * クラスタ化のしきい値(px)。「アンカー(クラスタ最初のアイテムの topPx)からこの
 * 距離以内なら同じクラスタに入れる」固定しきい値で、直前アイテムとの距離ではない
 * (直前アイテムとの距離で連結すると、5px間隔の commit が数十件続くケースで
 * 数十分にまたがるクラスタが数珠つなぎに出来てしまい、「近接した点をまとめる」
 * という目的を外れる)。既定ズーム(48px/h = 0.8px/分)のもとでは
 * 6px ≈ 7.5分に相当し、レール上の点(直径4px程度を想定)が視覚的に重ならない
 * 程度の間隔として選んだ値。
 *
 * 時間軸ズーム(2026-07-25)後も px 基準のまま据え置く ―― まとめる理由が「点が視覚的に
 * 重なる」ことなので、拡大すれば同じ px 距離がより短い時間に相当し、自然に細かく
 * 分かれる(=拡大したぶんだけ個々の commit が見分けられる)のが望ましい挙動。
 */
const CLUSTER_THRESHOLD_PX = 6;

/**
 * [dayStartMs, dayEndMs) に収まる items を抽出し、timestampMs 昇順に並べた上で、
 * CLUSTER_THRESHOLD_PX 以内で連続するアイテムを1クラスタにまとめる。
 * 半開区間の境界: dayStartMs ちょうどは含む、dayEndMs ちょうどは含まない
 * (layoutGitHubDay/overlapsBusy と同じ半開区間の流儀)。
 * 入力配列は変更しない。
 */
export function clusterByTopPx<T extends { timestampMs: number }>(
  items: readonly T[],
  dayStartMs: number,
  dayEndMs: number,
  hourHeight: number,
): TopPxCluster<T>[] {
  const dayItems = items
    .filter((it) => it.timestampMs >= dayStartMs && it.timestampMs < dayEndMs)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const clusters: TopPxCluster<T>[] = [];
  for (const item of dayItems) {
    const topPx = msToTopPx(item.timestampMs, dayStartMs, hourHeight);
    const current = clusters[clusters.length - 1];
    // アンカー(クラスタ先頭アイテムの topPx、更新しない)との距離で判定する
    if (current && topPx - current.topPx <= CLUSTER_THRESHOLD_PX) {
      current.items.push(item);
      current.count = current.items.length;
    } else {
      clusters.push({ topPx, items: [item], count: 1 });
    }
  }
  return clusters;
}

/**
 * クラスタのラベル末尾。2件以上なら代表(最新)アイテムのラベルの後ろに「 他N件」を足す。
 * DayColumn.tsx の実績レール(`.day-activity-mark`)と CI レール(`.day-ci-mark`)は
 * 代表アイテムの文言だけが違い、この畳み込み表示は完全に同じなのでここに置いてある
 * (レール本体の DOM は別々のまま ―― 差分は href/className/ステータス色まで及ぶため、
 * 共通化すると注入する props の方が多くなる)。
 */
export function clusterOverflowSuffix(count: number): string {
  return count > 1 ? ` 他${count - 1}件` : "";
}
