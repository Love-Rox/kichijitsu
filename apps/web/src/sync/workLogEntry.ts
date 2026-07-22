import type { PlannedBlock } from "../model/types";
import type { WorkLogCreateRequest, WorkLogDTO } from "@kichijitsu/shared";
import { datetimeLocalValueToMs } from "./eventEdit";

/**
 * 実績の手動追加(TimeReportOverlay「実績を手動で追加」フォーム、docs/mcp.md「エージェントの
 * 作業時間記録」、2026-07-22)。純関数層のみ — DOM/state 更新は TimeReportOverlay.tsx (フォーム)・
 * App.tsx (fetch 配線) が担う。hookActual.ts (hook 実績の突合) と並ぶ、work-log 関連の3つ目の
 * 純関数モジュール。
 *
 * datetime-local (`<input type="datetime-local">`) の値 → epoch ms の変換は EventEditForm と同じ
 * eventEdit.ts の datetimeLocalValueToMs (Temporal、アプリ設定の timeZone のローカル壁時計として
 * 解釈) を再利用する — ブラウザの実行時タイムゾームに依存する `new Date(value)` は、アプリの
 * カレンダー表示が使うタイムゾーン設定とずれる可能性があるため使わない。
 *
 * サーバー (POST /api/work-logs) は core/work-log.ts の validateWorkLogInput/buildWorkLogRow を
 * 再利用しており ISO 文字列の start/end を受け取る (POST /api/work-intervals と同じ形) ので、
 * epoch ms へ変換したあと `new Date(ms).toISOString()` で UTC の ISO 文字列に直して送る。
 */

/** 手動追加フォームの生入力。datetime-local の値 ("YYYY-MM-DDTHH:mm") をそのまま受け取る。 */
export interface WorkLogEntryFormInput {
  repo: string;
  issueRef: string;
  startLocal: string;
  endLocal: string;
  agent: string;
}

export type WorkLogEntryValidationError =
  | "missing_repo"
  | "invalid_start"
  | "invalid_end"
  | "start_not_before_end";

/** バリデーションエラーの日本語文言。フォームのエラー表示にそのまま使える。 */
export const WORK_LOG_ENTRY_ERROR_MESSAGES: Record<WorkLogEntryValidationError, string> = {
  missing_repo: "repo を入力してください",
  invalid_start: "開始日時を入力してください",
  invalid_end: "終了日時を入力してください",
  start_not_before_end: "終了は開始より後にしてください",
};

/** datetime-local の値を timeZone のローカル壁時計として epoch ms に変換する。空文字・不正な
 * 値 (Temporal がパースできない) は null を返す — validateWorkLogEntryForm がこれを検出する。 */
function tryParseLocalMs(value: string, timeZone: string): number | null {
  if (!value) return null;
  try {
    return datetimeLocalValueToMs(value, timeZone);
  } catch {
    return null;
  }
}

/**
 * 純関数。フォーム入力を検証する。core/work-log.ts の validateWorkLogInput (サーバー側) と
 * 判定基準を揃えてある(repo 必須・start/end パース可・start<end)。
 */
export function validateWorkLogEntryForm(
  input: WorkLogEntryFormInput,
  timeZone: string,
): WorkLogEntryValidationError | null {
  if (!input.repo.trim()) return "missing_repo";
  const startMs = tryParseLocalMs(input.startLocal, timeZone);
  if (startMs === null) return "invalid_start";
  const endMs = tryParseLocalMs(input.endLocal, timeZone);
  if (endMs === null) return "invalid_end";
  if (startMs >= endMs) return "start_not_before_end";
  return null;
}

/**
 * 純関数。検証済みの入力から POST /api/work-logs のリクエストボディを組み立てる。呼び出し側が
 * 事前に validateWorkLogEntryForm を呼んで null (エラー無し) を確認している前提で、ここでは
 * 検証しない (core/work-log.ts の buildWorkLogRow と同じ役割分担)。issueRef/agent は
 * 空文字/空白のみなら省略する — agent を省略すると resolveManualWorkLogAgent がサーバー側で
 * "manual" を補う。
 */
export function buildWorkLogCreateRequest(
  input: WorkLogEntryFormInput,
  timeZone: string,
): WorkLogCreateRequest {
  const startMs = datetimeLocalValueToMs(input.startLocal, timeZone);
  const endMs = datetimeLocalValueToMs(input.endLocal, timeZone);
  const issueRef = input.issueRef.trim();
  const agent = input.agent.trim();
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    repo: input.repo.trim(),
    ...(issueRef ? { issueRef } : {}),
    ...(agent ? { agent } : {}),
  };
}

/**
 * hook 記録か手動記録かを見分ける。サーバー側 (resolveManualWorkLogAgent) が手動フォーム由来の
 * 行には agent 未指定時に必ず "manual" を補うため、agent === "manual" を手動記録の目印として
 * 扱う。hook 側 (Claude Code 等) が偶然 "manual" という agent 名を送ってくることは無い想定
 * (docs/mcp.md の hook は "claude-code" 等の具体名を送る) — 万一送ってきた場合は区別できないが、
 * 削除ボタンが余分に出るだけで実害は無い(データを壊す方向のミスではない)。
 */
export function isManualWorkLog(workLog: Pick<WorkLogDTO, "agent">): boolean {
  return workLog.agent === "manual";
}

/**
 * 純関数。repo の入力補助 (datalist) 用に、既存の work-log 実績と予定タイムブロックから
 * repo 候補を重複無しで集める。完全な網羅ではなく「よく使う repo をサジェストできれば十分」
 * という位置づけ(候補に無い repo も自由入力できる、あくまで補助)。並びはアルファベット順
 * (毎回同じ順で出た方が使う側にとって分かりやすいため、頻度順のような凝った並びはしない)。
 */
export function collectWorkLogRepoCandidates(
  workLogs: readonly Pick<WorkLogDTO, "repo">[],
  plannedBlocks: readonly Pick<PlannedBlock, "repo">[],
): string[] {
  const repos = new Set<string>();
  for (const w of workLogs) repos.add(w.repo);
  for (const b of plannedBlocks) repos.add(b.repo);
  return Array.from(repos).sort((a, b) => a.localeCompare(b));
}
