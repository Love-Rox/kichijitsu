import type { WorkLogDTO, WorkLogIssueIdentity } from "@kichijitsu/shared";
import { aggregateWorkLogEntries, workLogIssueIdentity } from "@kichijitsu/shared";

/**
 * 実績履歴(work_logs)を「同じ issue/PR の記録」でまとめるための純関数
 * (実績 UX 刷新、2026-07-23)。WorkLogModal を廃した後は右ペイン(GitHubPane)の「実績履歴」が、
 * 全 work_logs のフラットな時系列一覧ではなく issue/PR 単位のグループ表示になるために使う。
 * DOM/store に触れない副作用フリー層(timeTracking.ts / workLogEntry.ts と同じ流儀)。
 *
 * グループは「issue 自身の同一性(所属 repo + 番号)」でまとめる。work_logs の issueRef は2形態:
 *  - `owner/repo#番号`(hook/MCP の完全参照。作業した repo とは別 repo の issue も指せる)
 *  - `番号`(UI タイマー/手動入力。log.repo に対する相対番号)
 * どちらも「issue の所属 repo + 番号」へ正規化してキーにするので、同じ issue を別の作業 repo
 * (例: 実装は lapras、issue は scouty)で記録しても1グループにまとまる。issueRef が空のものは
 * 「issue 無し」グループとして作業 repo 単位でまとめる。
 *
 * **正規化と集計の実体は @kichijitsu/shared (work-log.ts) に移した**(2026-07-25、リファクタリング
 * フェーズ4)。同じ「repo+issue でまとめて期間を合計する」処理が apps/sync 側にも
 * (MCP work_summary 用の aggregateWorkLogs として) 別定義で存在し、あちらは issue_ref を正規化して
 * いなかったため、web の実績履歴と MCP の数字が食い違っていた。バケットキーの正規化
 * (workLogIssueIdentity) と期間合計 (aggregateWorkLogEntries) は shared の1つだけを両者が使う。
 * このモジュールに残るのは web 固有の見せ方(グループの並び順・logs の並び・表示用の集計)。
 */
export interface WorkLogGroup {
  /** グループの一意キー(issue の所属 repo + 番号、または issue 無しは作業 repo)。 */
  key: string;
  /** 表示用の repo。issue 付きは issue の所属 repo(issueRef の完全参照優先)、issue 無しは作業 repo。 */
  repo: string;
  /** issue/PR 番号(issue 付きグループのみ)。issue 無しグループでは undefined。 */
  issueRef?: string;
  /** グループ内の記録を startMs 降順に並べたもの。 */
  logs: WorkLogDTO[];
  /** 各 log の (endMs - startMs) を加算した合計 ms(負や 0 の区間は加算しない)。 */
  totalMs: number;
  /** グループ内の記録数(一覧に出す件数なので、期間が負や 0 の記録も数える)。 */
  sessionCount: number;
  /** グループ内の最大 startMs(グループ並び順のキー)。 */
  latestStartMs: number;
}

/**
 * issue の同一性(所属 repo + 番号)。実体は shared の WorkLogIssueIdentity —
 * openIntervals.ts / hookActual.ts / コンポーネント側の import 元を変えないための別名。
 */
export type IssueIdentity = WorkLogIssueIdentity;

/**
 * 純関数。(作業 repo, issueRef) から issue の同一性を導く。実体は shared の workLogIssueIdentity
 * (**issueRef 正規化の唯一の置き場**、2026-07-25 に apps/sync と共有するため移設)。
 * 実績履歴のグループ化だけでなく、開区間の走行判定/メタ補完 (sync/openIntervals.ts) と hook 実績の
 * 突合 (sync/hookActual.ts) もここを通す — 以前は3系統がそれぞれ別解釈(素の `String(number)` 一致 /
 * 数値のみ)をしていたため、hook が完全参照 (`owner/repo#12`) で開始した開区間を UI 側が走行中と
 * 認識できず、同じ issue で二重に開区間ができる・壊れた fallback URL が出る、という不整合が起きていた。
 */
export { workLogIssueIdentity };

/**
 * 純関数。issue の同一性から「数値の issue/PR 番号」を取り出す。数値でない参照
 * (ブランチ名由来の `feat/foo` 等)や issue 無しは undefined。
 * repo+number をキーに他のデータ(作業キュー・予定タイムブロック・planned の linkedItemId)と
 * 突き合わせる側は数値番号でしか一致し得ないため、判定をここに集約する。
 */
export function issueIdentityNumber(identity: IssueIdentity): number | undefined {
  const ref = identity.issueRef;
  if (!ref || !/^\d+$/.test(ref)) return undefined;
  return Number(ref);
}

/**
 * work_logs を issue の同一性(所属 repo + 番号)でグループ化する。
 * - 各グループの logs は startMs 降順。
 * - totalMs は各 log の (endMs - startMs) の合計(負や 0 の区間は加算しない)。
 * - グループの並びは latestStartMs(グループ内最大 startMs)降順。
 *
 * グループ分けと totalMs の計算は shared の aggregateWorkLogEntries(apps/sync の MCP
 * work_summary と共有)。sessionCount だけはこちら固有で、shared の count(= 期間が正の記録数)
 * ではなく**一覧に出す記録数**(entries の数)を使う — 期間が反転した壊れた記録も一覧に出して
 * 利用者が訂正/削除できるようにするため、見出しの件数と一覧の行数を一致させる。
 */
export function groupWorkLogsByIssue(workLogs: WorkLogDTO[]): WorkLogGroup[] {
  return aggregateWorkLogEntries(workLogs)
    .map((bucket) => ({
      key: bucket.key,
      repo: bucket.repo,
      issueRef: bucket.issueRef,
      logs: [...bucket.entries].sort((a, b) => b.startMs - a.startMs),
      totalMs: bucket.totalMs,
      sessionCount: bucket.entries.length,
      latestStartMs: bucket.latestStartMs,
    }))
    .sort((a, b) => b.latestStartMs - a.latestStartMs);
}

/**
 * 純関数。issue タイトルのルックアップキーを組み立てる(`${repo}#${number}`)。
 * WorkLogModal が repo ごとに取得した open issue/PR 一覧を `repo#番号 → title` の Map/Record に
 * 収める際のキー生成と、グループ見出しの解決側でキーを引く際に共用する。number は fetch 側では
 * 数値、グループ側(issueRef)では文字列で来るが、いずれも同じ文字列キーへ正規化される。
 */
export function issueTitleKey(repo: string, number: string | number): string {
  return `${repo}#${number}`;
}

/**
 * 純関数。グループ群のうち issue を持つ(issueRef あり)グループの「所属 repo」を重複排除して返す。
 * WorkLogModal が各 repo の open issue/PR 一覧を1回ずつ取得してタイトルを解決するための対象集合。
 * issue 無しグループ(issueRef undefined)は repo 見出しにタイトルを付けないので対象外。
 * 出現順を保ったまま(初出優先で)重複を除く。
 */
export function distinctIssueRepos(groups: WorkLogGroup[]): string[] {
  const seen = new Set<string>();
  const repos: string[] = [];
  for (const group of groups) {
    if (!group.issueRef) continue;
    if (seen.has(group.repo)) continue;
    seen.add(group.repo);
    repos.push(group.repo);
  }
  return repos;
}

/** グループ一覧全体の集計(実績履歴の見出しに出す合計時間・記録数・グループ数)。 */
export interface WorkLogGroupsSummary {
  /** 全グループの totalMs 合計(= 全 work_log の Math.max(0, endMs-startMs) の合計)。 */
  totalMs: number;
  /** 全グループの記録数合計(= work_log の総数)。 */
  sessionCount: number;
  /** グループ数(issue/PR + issue 無しの種類数)。 */
  groupCount: number;
}

/** 純関数。グループ一覧全体の合計時間・記録数・グループ数をまとめる(実績履歴の見出し用)。 */
export function summarizeWorkLogGroups(groups: readonly WorkLogGroup[]): WorkLogGroupsSummary {
  let totalMs = 0;
  let sessionCount = 0;
  for (const group of groups) {
    totalMs += group.totalMs;
    sessionCount += group.sessionCount;
  }
  return { totalMs, sessionCount, groupCount: groups.length };
}
