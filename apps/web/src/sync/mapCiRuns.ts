import type { GitHubCiRunDTO } from "@kichijitsu/shared";
import { minutesToPx } from "../layout/gridMetrics";

/**
 * GitHub CI/Actions 実行オーバーレイ (docs/github-integration.md フェーズ④b「CI/Actions
 * 実行をタイムラインに薄く重ねる」) の DTO→日ごとのレイアウト変換を担う純関数層。
 * sync/mapActivity.ts (フェーズ③実績オーバーレイ Part B) を鏡にした実装 — commit 実績が
 * 日列右端の `.day-activity-rail` に乗るのに対し、CI 実行は左端の `.day-ci-rail` に乗せて
 * 分離する(DayColumn.tsx 参照)。クラスタリングのしきい値・アンカー方式は mapActivity.ts と
 * 完全に同じ(近接タイムスタンプを1クラスタにまとめ、密集時の視認性/クリック可能性を保つ)。
 */

/** 1日ぶんの GitHubCiRunDTO をまとめたクラスタ(近接タイムスタンプの run 群) */
export interface GitHubCiCluster {
  /** minutesToPx((anchorMs - dayStartMs)/60000) の結果。クラスタの代表位置(先頭アイテムの位置) */
  topPx: number;
  /** クラスタに属する items。timestampMs 昇順 */
  items: GitHubCiRunDTO[];
  /** items.length のショートカット(呼び出し側の可読性のため) */
  count: number;
}

/** クラスタ化のしきい値(px)。sync/mapActivity.ts の CLUSTER_THRESHOLD_PX と同じ値・同じ理由。 */
const CLUSTER_THRESHOLD_PX = 6;

/**
 * [dayStartMs, dayEndMs) に収まる GitHubCiRunDTO を抽出し、timestampMs 昇順に並べた上で、
 * CLUSTER_THRESHOLD_PX 以内で連続するアイテムを1クラスタにまとめる。半開区間の境界の扱いは
 * sync/mapActivity.ts の layoutDayActivity と同じ(dayStartMs ちょうどは含む、dayEndMs ちょうどは
 * 除外する)。入力配列は変更しない。
 */
export function layoutDayCiRuns(
  items: GitHubCiRunDTO[],
  dayStartMs: number,
  dayEndMs: number,
): GitHubCiCluster[] {
  const dayItems = items
    .filter((it) => it.timestampMs >= dayStartMs && it.timestampMs < dayEndMs)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const clusters: GitHubCiCluster[] = [];
  for (const item of dayItems) {
    const topPx = minutesToPx((item.timestampMs - dayStartMs) / 60_000);
    const current = clusters[clusters.length - 1];
    // アンカー(クラスタ先頭アイテムの topPx、更新しない)との距離で判定する(mapActivity.ts と同じ)
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
 * 1件の run から表示上のステータス区分を決める。DayColumn.tsx のマーカー色分け
 * (`status-{class}` クラス)に使う。GitHubCiConclusion の8値をそのまま塗り分けると視覚的な
 * 意味が薄くなるため、「成功/失敗/進行中/その他」の4区分に丸める:
 * - status !== 'completed' (queued/in_progress) は "pending" (進行中、点滅なしの薄墨)
 * - conclusion === 'success' は "success" (緑)
 * - conclusion === 'failure' は "failure" (✕グリフ、朱とは別文脈の控えめな danger)
 * - それ以外(cancelled/skipped/neutral/timed_out/action_required/startup_failure/null) は
 *   "other" (薄墨、pending と同色だが意味は異なる)
 */
export function ciMarkerStatusClass(
  run: GitHubCiRunDTO,
): "success" | "failure" | "pending" | "other" {
  if (run.status !== "completed") return "pending";
  if (run.conclusion === "success") return "success";
  if (run.conclusion === "failure") return "failure";
  return "other";
}

/** ホバー/クリック時のラベルに使う人間可読なステータス文字列(GitHub の生文字列をそのまま出す)。 */
export function ciStatusLabel(run: GitHubCiRunDTO): string {
  if (run.status !== "completed") return run.status;
  return run.conclusion ?? run.status;
}
