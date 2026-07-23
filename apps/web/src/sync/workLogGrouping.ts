import type { WorkLogDTO } from "@kichijitsu/shared";

/**
 * 実績履歴(work_logs)を「同じ issue/PR の記録」でまとめるための純関数
 * (実績 UX 刷新、2026-07-23)。WorkLogModal の下段「実績履歴」を、全 work_logs のフラットな
 * 時系列一覧から repo+issue 単位のグループ表示に置き換えるために使う。DOM/store に触れない
 * 副作用フリー層(timeTracking.ts / workLogEntry.ts と同じ流儀)。
 *
 * グループキーは repo + issueRef。issueRef が未指定/空文字のものは「issue 無し」グループとして
 * repo 単位でまとめる(issueRef を持つ記録とは別グループになる)。
 */
export interface WorkLogGroup {
  /** グループの一意キー(`${repo} ${issueRef ?? ""}`)。issueRef を持つものと持たないものが衝突しない形。 */
  key: string;
  repo: string;
  /** issueRef を持つグループのみ設定。issue 無しグループでは undefined。 */
  issueRef?: string;
  /** グループ内の記録を startMs 降順に並べたもの。 */
  logs: WorkLogDTO[];
  /** 各 log の (endMs - startMs) を Math.max(0, …) で加算した合計 ms(負や 0 は加算しない)。 */
  totalMs: number;
  /** グループ内の記録数。 */
  sessionCount: number;
  /** グループ内の最大 startMs(グループ並び順のキー)。 */
  latestStartMs: number;
}

/** issueRef が実質「無し」かどうか(undefined / 空文字 / 空白のみを「無し」扱いにする)。 */
function hasIssueRef(issueRef: string | undefined): issueRef is string {
  return typeof issueRef === "string" && issueRef.trim() !== "";
}

/**
 * work_logs を repo + issueRef でグループ化する。
 * - グループキー = `${repo} ${issueRef ?? ""}`(issueRef 無しは repo 単位でまとまる)。
 * - 各グループの logs は startMs 降順。
 * - totalMs は各 log の Math.max(0, endMs - startMs) の合計。
 * - グループの並びは latestStartMs(グループ内最大 startMs)降順。
 */
export function groupWorkLogsByIssue(workLogs: WorkLogDTO[]): WorkLogGroup[] {
  const groups = new Map<string, WorkLogGroup>();

  for (const log of workLogs) {
    const issueRef = hasIssueRef(log.issueRef) ? log.issueRef.trim() : undefined;
    const key = `${log.repo} ${issueRef ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        repo: log.repo,
        issueRef,
        logs: [],
        totalMs: 0,
        sessionCount: 0,
        latestStartMs: log.startMs,
      };
      groups.set(key, group);
    }
    group.logs.push(log);
    group.totalMs += Math.max(0, log.endMs - log.startMs);
    group.sessionCount += 1;
    if (log.startMs > group.latestStartMs) group.latestStartMs = log.startMs;
  }

  const result = [...groups.values()];
  for (const group of result) {
    group.logs.sort((a, b) => b.startMs - a.startMs);
  }
  result.sort((a, b) => b.latestStartMs - a.latestStartMs);
  return result;
}
