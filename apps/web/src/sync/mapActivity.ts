import type { GitHubActivityDTO } from "@kichijitsu/shared";
import { clusterByTopPx, type TopPxCluster } from "../layout/clusterByTopPx";

/**
 * GitHub 実績オーバーレイ (docs/github-integration.md フェーズ③Part B) の
 * DTO→日ごとのレイアウト変換を担う純関数層(mapGitHub.ts と同じ考え方)。
 * 副作用を持たないため WeekGrid.tsx からは呼ぶだけ。
 *
 * commit 実績は milestone レーンのような「行」を持たず、DayColumn.tsx の日列右端の
 * 細い「レール」(DAY_COLUMN_INSET_PX ぶんのガター)に、タイムスタンプそのままの
 * 縦位置で小さな点として置く。1日に何十件も commit がある日はそのままだと点が
 * 密集して視認できず・クリックもしづらくなるため、近接した点は1つの「クラスタ」に
 * まとめて描画する(GitHubDayLayout の milestone グルーピングとは別軸の集約)。
 *
 * クラスタリング本体は layout/clusterByTopPx.ts に共通化してある(2026-07-26 ―― CI 実行側の
 * sync/mapCiRuns.ts と行単位で同一だったため。しきい値・アンカー方式・半開区間の境界の扱いは
 * すべてそちらのコメント参照)。このファイルに残っているのは「commit 実績用の型を当てる」ことだけ。
 */

/** 1日ぶんの GitHubActivityDTO をまとめたクラスタ(近接タイムスタンプの commit 群) */
export type GitHubActivityCluster = TopPxCluster<GitHubActivityDTO>;

/**
 * [dayStartMs, dayEndMs) に収まる GitHubActivityDTO を抽出し、timestampMs 昇順に並べた上で、
 * 近接するアイテムを1クラスタにまとめる(clusterByTopPx)。入力配列は変更しない。
 */
export function layoutDayActivity(
  items: GitHubActivityDTO[],
  dayStartMs: number,
  dayEndMs: number,
  hourHeight: number,
): GitHubActivityCluster[] {
  return clusterByTopPx(items, dayStartMs, dayEndMs, hourHeight);
}
