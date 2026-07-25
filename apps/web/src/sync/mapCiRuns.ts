import type { GitHubCiRunDTO } from "@kichijitsu/shared";
import { clusterByTopPx, type TopPxCluster } from "../layout/clusterByTopPx";

/**
 * GitHub CI/Actions 実行オーバーレイ (docs/github-integration.md フェーズ④b「CI/Actions
 * 実行をタイムラインに薄く重ねる」) の DTO→日ごとのレイアウト変換を担う純関数層。
 * sync/mapActivity.ts (フェーズ③実績オーバーレイ Part B) を鏡にした実装 — commit 実績が
 * 日列右端の `.day-activity-rail` に乗るのに対し、CI 実行は左端の `.day-ci-rail` に乗せて
 * 分離する(DayColumn.tsx 参照)。
 *
 * クラスタリング本体は 2026-07-26 に layout/clusterByTopPx.ts へ共通化した ―― 「しきい値・
 * アンカー方式は mapActivity.ts と完全に同じ」と両ファイルのコメントが自認していた実装が
 * 行単位で重複していたため。このファイルに残っているのは CI 固有の型付けと、マーカーの
 * ステータス区分(下記2関数)だけ。
 */

/** 1日ぶんの GitHubCiRunDTO をまとめたクラスタ(近接タイムスタンプの run 群) */
export type GitHubCiCluster = TopPxCluster<GitHubCiRunDTO>;

/**
 * [dayStartMs, dayEndMs) に収まる GitHubCiRunDTO を抽出し、timestampMs 昇順に並べた上で、
 * 近接するアイテムを1クラスタにまとめる(clusterByTopPx)。入力配列は変更しない。
 */
export function layoutDayCiRuns(
  items: GitHubCiRunDTO[],
  dayStartMs: number,
  dayEndMs: number,
  hourHeight: number,
): GitHubCiCluster[] {
  return clusterByTopPx(items, dayStartMs, dayEndMs, hourHeight);
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
