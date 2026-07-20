import type { GitHubActivityDTO } from "@kichijitsu/shared";
import { minutesToPx } from "../layout/gridMetrics";

/**
 * GitHub 実績オーバーレイ (docs/github-integration.md フェーズ③Part B) の
 * DTO→日ごとのレイアウト変換を担う純関数層(mapGitHub.ts と同じ考え方)。
 * 副作用を持たないため WeekGrid.tsx からは呼ぶだけ(クラスタリングの分岐ロジックは
 * ここに集約してテストする)。
 *
 * commit 実績は milestone レーンのような「行」を持たず、DayColumn.tsx の日列右端の
 * 細い「レール」(DAY_COLUMN_INSET_PX ぶんのガター)に、タイムスタンプそのままの
 * 縦位置で小さな点として置く。1日に何十件も commit がある日はそのままだと点が
 * 密集して視認できず・クリックもしづらくなるため、近接した点は1つの「クラスタ」に
 * まとめて描画する(GitHubDayLayout の milestone グルーピングとは別軸の集約)。
 */

/** 1日ぶんの GitHubActivityDTO をまとめたクラスタ(近接タイムスタンプの commit 群) */
export interface GitHubActivityCluster {
  /** minutesToPx((anchorMs - dayStartMs)/60000) の結果。クラスタの代表位置(先頭アイテムの位置) */
  topPx: number;
  /** クラスタに属する items。timestampMs 昇順 */
  items: GitHubActivityDTO[];
  /** items.length のショートカット(呼び出し側の可読性のため) */
  count: number;
}

/**
 * クラスタ化のしきい値(px)。「アンカー(クラスタ最初のアイテムの topPx)からこの
 * 距離以内なら同じクラスタに入れる」固定しきい値で、直前アイテムとの距離ではない
 * (直前アイテムとの距離で連結すると、5px間隔の commit が数十件続くケースで
 * 数十分にまたがるクラスタが数珠つなぎに出来てしまい、「近接した点をまとめる」
 * という目的を外れる)。PX_PER_MINUTE=0.8 (gridMetrics.ts) のもとでは
 * 6px ≈ 7.5分に相当し、レール上の点(直径4px程度を想定)が視覚的に重ならない
 * 程度の間隔として選んだ値。
 */
const CLUSTER_THRESHOLD_PX = 6;

/**
 * [dayStartMs, dayEndMs) に収まる GitHubActivityDTO を抽出し、timestampMs 昇順に並べた上で、
 * CLUSTER_THRESHOLD_PX 以内で連続するアイテムを1クラスタにまとめる。
 * 半開区間の境界: dayStartMs ちょうどは含む、dayEndMs ちょうどは含まない
 * (layoutGitHubDay/overlapsBusy と同じ半開区間の流儀)。
 * 入力配列は変更しない。
 */
export function layoutDayActivity(
  items: GitHubActivityDTO[],
  dayStartMs: number,
  dayEndMs: number,
): GitHubActivityCluster[] {
  const dayItems = items
    .filter((it) => it.timestampMs >= dayStartMs && it.timestampMs < dayEndMs)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const clusters: GitHubActivityCluster[] = [];
  for (const item of dayItems) {
    const topPx = minutesToPx((item.timestampMs - dayStartMs) / 60_000);
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
