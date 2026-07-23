import type { PlannedBlock, TimeEntry } from "../model/types";
import type { WorkLogDTO } from "@kichijitsu/shared";
import { reportItemKey } from "./estimateActual";
import { hookActualByLinkedItem } from "./hookActual";
import { aggregatePlannedVsActual, type ReportRow as PlannedVsActualRow } from "./timeTracking";

/**
 * GitHub 情報ペイン「実績」セクション(docs/github-integration.md「時間計測」増分2 Part B、
 * 2026-07-21)向けの統合レポート行 + CSV 化の純関数群。DOM/store には一切触れない。
 *
 * TimeReportOverlay.tsx は表示のたびに aggregatePlannedVsActual/hookActualByLinkedItem/
 * estimateByItemKey の3つを個別に呼んで行内で突き合わせている(表示ロジックと突合ロジックが
 * 密結合)。ここではその3経路を1つの `ReportRow[]` にマージする層を切り出し、CSV/コピー
 * 出力から同じ行データを再利用できるようにする。実績 UX 刷新(2026-07-23)で CSV エクスポートは
 * 旧 GitHubPane 実績セクションから TimeReportOverlay へ移設したため、現在の利用側は
 * TimeReportOverlay の CSV 出力(表側の予定/実績表示は従来どおり aggregatePlannedVsActual を
 * 直接使い、突合ロジックの重複だけを避ける設計は据え置き)。
 */

/** buildReportRows が返す1行。予定/実績(手動)は既存 ReportRow、hook 実績・推定を追加で持つ */
export interface ActualsReportRow extends PlannedVsActualRow {
  /** hook 実績(sync/hookActual.ts)。一致が無ければ undefined(「未取得/該当なし」を意味する) */
  hookActualMs: number | undefined;
  /** commit からの推定実績(sync/estimateActual.ts)。PR のみ値が入りうる、issue は常に undefined */
  estimateMs: number | undefined;
}

export interface BuildReportRowsInput {
  plannedBlocks: PlannedBlock[];
  timeEntries: TimeEntry[];
  workLogs: WorkLogDTO[];
  /** POST /api/github/pr-commits 由来の推定 ms。キーは reportItemKey (`${repo}#${number}`) */
  estimatesByKey: Record<string, number>;
}

/**
 * 予定/実績(手動)は aggregatePlannedVsActual (timeTracking.ts) にそのまま委譲し
 * (並び順・網羅性もそちらに従う — 予定だけ/実績だけの item も含む)、各行へ
 * hookActualByLinkedItem (linkedItemId キー) と estimatesByKey (reportItemKey キー、PR のみ)
 * をマージする。一致しない行は hookActualMs/estimateMs が undefined のまま
 * (TimeReportOverlay と同じ「取れないものは undefined、0 と混同しない」方針)。
 */
export function buildReportRows(
  { plannedBlocks, timeEntries, workLogs, estimatesByKey }: BuildReportRowsInput,
  nowMs: number = Date.now(),
): ActualsReportRow[] {
  const baseRows = aggregatePlannedVsActual(plannedBlocks, timeEntries, nowMs);
  const hookByLinkedItem = hookActualByLinkedItem(
    workLogs,
    baseRows.map((row) => row.linkedItemId),
  );

  return baseRows.map((row) => ({
    ...row,
    hookActualMs: hookByLinkedItem[row.linkedItemId],
    estimateMs: row.itemType === "pr" ? estimatesByKey[reportItemKey(row)] : undefined,
  }));
}

/** CSV の1フィールドを RFC4180 準拠でエスケープする。カンマ/引用符/改行(CR・LF)を含む場合のみクォートする */
function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** ms を undefined 許容で分単位の文字列に変換する。undefined(未取得/該当なし)は空文字("該当なし"と"0分"を区別する) */
function msToMinutesField(ms: number | undefined): string {
  if (ms === undefined) return "";
  return String(Math.round(ms / 60_000));
}

const CSV_HEADER = [
  "repo",
  "number",
  "type",
  "title",
  "planned_min",
  "actual_manual_min",
  "actual_hook_min",
  "estimate_min",
].join(",");

/**
 * buildReportRows の結果を CSV 文字列(ヘッダー行付き、改行は "\r\n"、単位は分)に変換する。
 * hookActualMs/estimateMs が undefined(未取得/該当なし)の行は該当セルを空文字にする
 * (0分の実績と紛れないようにするため — スプレッドシートで空セルのまま扱える)。
 * 空配列ならヘッダーのみの1行を返す。
 */
export function reportRowsToCsv(rows: ActualsReportRow[]): string {
  const lines = [CSV_HEADER];
  for (const row of rows) {
    lines.push(
      [
        escapeCsvField(row.repo),
        String(row.number),
        row.itemType,
        escapeCsvField(row.title),
        msToMinutesField(row.plannedMs),
        msToMinutesField(row.actualMs),
        msToMinutesField(row.hookActualMs),
        msToMinutesField(row.estimateMs),
      ].join(","),
    );
  }
  return lines.join("\r\n");
}
