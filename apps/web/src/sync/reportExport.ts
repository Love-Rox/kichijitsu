import type { PlannedBlock, TimeEntry } from "../model/types";
import type { WorkLogDTO } from "@kichijitsu/shared";
import { reportItemKey } from "./estimateActual";
import { hookActualByLinkedItem, workLogItemRef } from "./hookActual";
import { aggregatePlannedVsActual, type ReportRow as PlannedVsActualRow } from "./timeTracking";

/**
 * GitHub 情報ペイン「実績」セクション(docs/github-integration.md「時間計測」増分2 Part B、
 * 2026-07-21)向けの統合レポート行 + CSV 化の純関数群。DOM/store には一切触れない。
 *
 * 当初 TimeReportOverlay.tsx は表示のたびに aggregatePlannedVsActual/hookActualByLinkedItem/
 * estimateByItemKey の3つを個別に呼んで行内で突き合わせていた(表示ロジックと突合ロジックが
 * 密結合)。ここではその3経路を1つの `ReportRow[]` にマージする層を切り出し、CSV/コピー
 * 出力から同じ行データを再利用できるようにする。実績 UX 刷新(2026-07-23)で CSV エクスポートは
 * 旧 GitHubPane 実績セクションから TimeReportOverlay へ移設した。
 *
 * 2026-07-25 以降は表示側も buildReportRows の結果をそのまま使う(表と CSV で行の母集合が
 * 違うと「表には出るが CSV に無い」「CSV には出るが表が空」というズレが起きるため、行の
 * 母集合と突合はこの層に一本化する)。
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
 * work_logs にしか存在しない item(予定タイムブロックも走行中タイマーも無い)の行を組み立てる。
 * covered には既に行がある item の reportItemKey (`repo#number`) を渡し、そこに含まれるものは
 * 作らない(同じ item を issue 行と pr 行に二重で出さないため — 予定側に pr 行があるなら
 * hook 実績はその pr 行へ足し込まれる)。
 *
 * メタ情報の欠損への態度は openIntervals.ts の「メタが引けない開区間」と同じ流儀:
 * work_log は title/type を持たないので itemType は "issue" 固定、title は空文字
 * (表示側は `#番号` と repo を出す)、url は `/issues/{番号}`(PR なら GitHub が /pull へ
 * リダイレクトしてくれる)にフォールバックする。plannedMs/actualMs は 0 で、この行の実績は
 * hookActualMs 列(work_logs)にだけ現れる。
 */
function workLogOnlyRows(
  workLogs: WorkLogDTO[],
  covered: ReadonlySet<string>,
): PlannedVsActualRow[] {
  const rows = new Map<string, PlannedVsActualRow>();
  for (const workLog of workLogs) {
    const ref = workLogItemRef(workLog);
    if (!ref) continue; // issue 番号が数値にならない work_log は item に紐づけられない
    const key = reportItemKey(ref);
    if (covered.has(key) || rows.has(key)) continue;
    rows.set(key, {
      linkedItemId: `ghq:${ref.repo}:issue:${ref.number}`,
      itemType: "issue",
      title: "",
      repo: ref.repo,
      number: ref.number,
      url: `https://github.com/${ref.repo}/issues/${ref.number}`,
      plannedMs: 0,
      actualMs: 0,
    });
  }
  return [...rows.values()];
}

/** 行の並び順キー。「実績」= 走行中の経過(actualMs)+ work_logs(hookActualMs)の合計 */
function totalActualMs(row: ActualsReportRow): number {
  return row.actualMs + (row.hookActualMs ?? 0);
}

/**
 * 行の母集合は「予定タイムブロック ∪ 走行中タイマー ∪ work_logs」。予定/実績(手動)は
 * aggregatePlannedVsActual (timeTracking.ts) に委譲し(予定だけ/実績だけの item も含む)、
 * そこに現れない work_logs 由来の item を workLogOnlyRows で足したうえで、各行へ
 * hookActualByLinkedItem (linkedItemId キー) と estimatesByKey (reportItemKey キー、PR のみ)
 * をマージする。一致しない行は hookActualMs/estimateMs が undefined のまま
 * (TimeReportOverlay と同じ「取れないものは undefined、0 と混同しない」方針)。
 *
 * work_logs を母集合に含める理由 (2026-07-25 修正): フェーズ5b 以降 timeEntries は
 * 「サーバー開区間の射影 = 走行中のみ」に縮小され、確定した実績は work_logs にしか無い。
 * 予定を立てずに実績だけ記録する(手動記録・▶→⏹ で計測した分)経路がそのまま抜け落ち、
 * レポートが「まだ予定・実績がありません」になり CSV も空になっていた。
 *
 * 並びは実績合計(走行中 + work_logs)降順 → 予定降順 → タイトル昇順 → linkedItemId 昇順。
 * aggregatePlannedVsActual の並び(actualMs のみで比較)をここで組み直しているのは、実績の
 * 主体が work_logs へ移った以上「実績が多い item を上に出す」意図を満たすには hookActualMs も
 * 見る必要があるため。linkedItemId の比較は work_logs 由来の行(title が空)同士の並びを
 * 決定的にするための最終タイブレーク。
 */
export function buildReportRows(
  { plannedBlocks, timeEntries, workLogs, estimatesByKey }: BuildReportRowsInput,
  nowMs: number = Date.now(),
): ActualsReportRow[] {
  const baseRows = aggregatePlannedVsActual(plannedBlocks, timeEntries, nowMs);
  const covered = new Set(baseRows.map((row) => reportItemKey(row)));
  const allRows = [...baseRows, ...workLogOnlyRows(workLogs, covered)];
  const hookByLinkedItem = hookActualByLinkedItem(
    workLogs,
    allRows.map((row) => row.linkedItemId),
  );

  return allRows
    .map((row) => ({
      ...row,
      hookActualMs: hookByLinkedItem[row.linkedItemId],
      estimateMs: row.itemType === "pr" ? estimatesByKey[reportItemKey(row)] : undefined,
    }))
    .sort(
      (a, b) =>
        totalActualMs(b) - totalActualMs(a) ||
        b.plannedMs - a.plannedMs ||
        a.title.localeCompare(b.title) ||
        a.linkedItemId.localeCompare(b.linkedItemId),
    );
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
