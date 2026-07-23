import type { PlannedBlock, TimeEntry } from "../model/types";
import type { WorkLogCreateRequest, WorkLogDTO, WorkLogUpdateRequest } from "@kichijitsu/shared";
import { datetimeLocalValueToMs, msToDatetimeLocalValue } from "./eventEdit";

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
 * 純関数。停止済み(endMs !== null)の手動タイマー実績 (TimeEntry) を POST /api/work-logs の
 * リクエストボディへ変換する(実績 UX 刷新フェーズ4、2026-07-23)。タイマー停止時に
 * App.onStopTimer がこれを組み立てて work_logs へ保存し、成功したらローカルの TimeEntry を
 * 破棄する — これにより実績は work_logs 一本に統一され、ローカルの確定済み TimeEntry と
 * サーバー実績の二重計上を避ける。
 *
 * 変換規則:
 *   - start/end: epoch ms を `new Date(ms).toISOString()` で UTC の ISO 文字列へ
 *     (buildWorkLogCreateRequest と同じ、サーバーは ISO 文字列を期待する)。
 *   - repo: entry.repo をそのまま("owner/repo" 形式で非正規化済み)。
 *   - issueRef: entry.number を文字列化(サーバーの issueRef は string)。
 *   - agent: "timer" 固定 — 手動フォーム由来 ("manual") や hook 由来 (具体名) と区別でき、
 *     WorkLogModal/レポートでタイマー実績を見分けられる。
 *
 * endMs が null(走行中)のまま渡すのは呼び出し側のバグ。ISO 変換で NaN の文字列を送って
 * サーバーを 400 にするより、ここで明示的に投げて呼び出し側で気付けるようにする
 * (App.onStopTimer は必ず stopTimer() で確定してから呼ぶ)。
 */
export function workLogRequestFromTimer(entry: TimeEntry): WorkLogCreateRequest {
  if (entry.endMs === null) {
    throw new Error("workLogRequestFromTimer: entry must be stopped (endMs !== null)");
  }
  return {
    start: new Date(entry.startMs).toISOString(),
    end: new Date(entry.endMs).toISOString(),
    repo: entry.repo,
    issueRef: String(entry.number),
    agent: "timer",
  };
}

/**
 * 純関数。既存の work-log (WorkLogDTO) を編集フォームの生入力 (WorkLogEntryFormInput) へ
 * 変換する — WorkLogModal のインライン編集フォームが「現値でプリフィル」するために使う。
 * startMs/endMs は msToDatetimeLocalValue で datetime-local の壁時計値 (timeZone のローカル、
 * 分精度) へ戻す。issueRef/agent は未設定 (undefined) なら空文字にする (フォームの <input> は
 * 常に string を要求するため)。repo は "org/repo" 形式のまま1つの repo 欄へ入れる —
 * 編集フォームは手動追加フォームと違い org/repo を分割しない (combineOrgRepo は使わない)。
 */
export function workLogToFormInput(dto: WorkLogDTO, timeZone: string): WorkLogEntryFormInput {
  return {
    repo: dto.repo,
    issueRef: dto.issueRef ?? "",
    startLocal: msToDatetimeLocalValue(dto.startMs, timeZone),
    endLocal: msToDatetimeLocalValue(dto.endMs, timeZone),
    agent: dto.agent ?? "",
  };
}

/**
 * 純関数。検証済みの編集フォーム入力から PATCH /api/work-logs/:id のリクエストボディを組み立てる。
 * buildWorkLogCreateRequest と同じ流儀で、呼び出し側が事前に validateWorkLogEntryForm を呼んで
 * null (エラー無し) を確認している前提。WorkLogUpdateRequest は「与えたキーだけ更新」する部分更新
 * だが、編集フォームは repo/開始/終了を必須入力として現値からプリフィルするため、これら3つは常に
 * 送る (壁時計値 → epoch ms → UTC の ISO 文字列は create と同じ変換)。issueRef/agent は
 * 空文字/空白のみなら省略する — 省略したキーはサーバー側で現状維持になる (このため空欄にしても
 * その項目を「消す」ことはできないが、hook 記録の agent を現値でプリフィルしてそのまま送り返す
 * ことで維持できる、という編集フォームの前提と整合する)。
 */
export function buildWorkLogUpdateRequest(
  input: WorkLogEntryFormInput,
  timeZone: string,
): WorkLogUpdateRequest {
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

/**
 * 純関数。org 欄の入力補助 (datalist) 用に、既存 repo 候補("org/repo" 形式が主)から org 部分
 * ("/" の左側)だけを重複無しで集める。collectWorkLogRepoCandidates を土台にする
 * (repo と org のサジェスト元を揃える)。"/" を含まない repo(org 無し)や先頭が "/" の
 * 値(org 部分が空)は org を持たないものとして除外する。並びは repo 候補と同じアルファベット順。
 */
export function collectWorkLogOrgCandidates(
  workLogs: readonly Pick<WorkLogDTO, "repo">[],
  plannedBlocks: readonly Pick<PlannedBlock, "repo">[],
): string[] {
  const orgs = new Set<string>();
  for (const repo of collectWorkLogRepoCandidates(workLogs, plannedBlocks)) {
    const slash = repo.indexOf("/");
    if (slash > 0) orgs.add(repo.slice(0, slash));
  }
  return Array.from(orgs).sort((a, b) => a.localeCompare(b));
}

/**
 * 純関数。手動追加フォームの org 欄・repo 欄を、サーバーの WorkLogCreateRequest.repo が期待する
 * "org/repo" 形式の1文字列へ結合する。送信ボディの形(repo フィールド1つ)は変えず、UI 側だけ
 * org と repo を別入力にするためのアダプタ。repo 欄を主(必須)、org 欄を接頭辞の補助として扱う:
 *   - repo 欄が空 → 空文字(呼び出し側の validateWorkLogEntryForm が missing_repo を返す)
 *   - repo 欄が既に "/" を含む(利用者が repo 欄へ "org/repo" を直接入れた、または repo 候補の
 *     datalist から完全形を選んだ)→ 二重結合を避けるため org 欄は無視して repo 欄をそのまま使う
 *   - それ以外 → org 欄が非空なら "org/repo"、空なら repo 欄のみ
 * 両欄とも前後の空白は trim する。
 */
export function combineOrgRepo(org: string, repo: string): string {
  const r = repo.trim();
  if (!r) return "";
  if (r.includes("/")) return r;
  const o = org.trim();
  return o ? `${o}/${r}` : r;
}
