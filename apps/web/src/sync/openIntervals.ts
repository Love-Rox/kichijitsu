import type {
  GitHubWorkItemDTO,
  OpenWorkIntervalDTO,
  WorkIntervalStopRequest,
} from "@kichijitsu/shared";
import type { PlannedBlock, TimeEntry } from "../model/types";
import { issueIdentityNumber, workLogIssueIdentity } from "./workLogGrouping";

/**
 * サーバーの開区間 (GET /api/work-logs/open、OpenWorkIntervalDTO) を「走行中(実行中)状態」の
 * 単一の真実として扱うための純関数群(実績 UX 刷新フェーズ5b、2026-07-23)。フェーズ4までは
 * ▶/⏹ がローカルの TimeEntry(IndexedDB)を作っていたが、5b でサーバーの start/stop API に
 * 接続し、走行中はサーバー共有の開区間で表す。
 *
 * ただし WeekGrid(触れないファイル)と RunningTimersIndicator が既存の TimeEntry[] /
 * timeEntryStore を消費するため、TimeEntryStore は「サーバー開区間の射影(走行中キャッシュ)」
 * として残す。ここは OpenWorkIntervalDTO → TimeEntry の変換と、走行判定を担う。
 *
 * OpenWorkIntervalDTO は {id, repo, issueRef?, branch?, agent?, startMs} しか持たず title/url/type が
 * 無い。そこで作業キュー (GitHubWorkItemDTO) と予定タイムブロック (PlannedBlock) から
 * repo+number でメタ(linkedItemId/itemType/title/url)を補完する。補完できない開区間
 * (MCP など別経路で作業キューにも予定にも無いもの)は linkedItemId=開区間の id を使い、
 * `repo #issue` 表示にフォールバックする。
 *
 * issueRef の正規化 (2026-07-25): OpenWorkIntervalDTO.issueRef は経路によって形が違う ――
 * UI タイマー/手動は作業 repo に対する素の `12`、hook/MCP は別 repo も指せる完全参照
 * `owner/repo#12`。以前ここは `String(number)` との単純一致だけを見ていたため、hook が
 * 完全参照で開始した開区間を「実行中」と認識できず、同じ issue に2本目の開区間ができたり
 * `https://github.com/{repo}/issues/owner/repo#12` という壊れた URL を作っていた。判定は
 * work_logs のグループ化と同じ workLogIssueIdentity(sync/workLogGrouping.ts)に一元化する。
 */

interface TimerItemMeta {
  /** 走行判定・右ペイン(GitHubPane)/WeekGrid のハイライトに使う。PlannedBlock.linkedItemId と同体系 */
  linkedItemId: string;
  itemType: "issue" | "pr";
  title: string;
  url: string;
}

/** メタ表の引き当てキー。番号は必ず数値に正規化してから渡す(文字列の生 issueRef を混ぜない)。 */
function metaKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

/**
 * repo+number → メタ の対応表を作る。作業キュー(GitHub の生データ、タイトルが最新)を予定より
 * 優先する — 同じ repo+number があれば後勝ちで queue が上書きする。
 */
export function buildTimerItemLookup(
  plannedBlocks: readonly PlannedBlock[],
  queueItems: readonly GitHubWorkItemDTO[],
): Map<string, TimerItemMeta> {
  const map = new Map<string, TimerItemMeta>();
  for (const b of plannedBlocks) {
    map.set(metaKey(b.repo, b.number), {
      linkedItemId: b.linkedItemId,
      itemType: b.itemType,
      title: b.title,
      url: b.url,
    });
  }
  for (const q of queueItems) {
    map.set(metaKey(q.repo, q.number), {
      linkedItemId: q.id,
      itemType: q.type,
      title: q.title,
      url: q.url,
    });
  }
  return map;
}

/**
 * メタが引けなかったときの遷移先 URL。issue/PR どちらでも /issues/N で開ける(PR は GitHub が
 * /pull/N へリダイレクトする)。番号が数値として取れないときは /issues/{生の参照} という
 * 存在しない URL を作らず、その repo の issue 一覧(番号が無ければ repo トップ)に落とす。
 * issueRepo は「issue の所属 repo」(完全参照ならそちら、素の番号なら作業 repo)を渡す。
 */
function fallbackUrl(issueRepo: string, number: number | undefined, hasIssue: boolean): string {
  if (number !== undefined) return `https://github.com/${issueRepo}/issues/${number}`;
  if (hasIssue) return `https://github.com/${issueRepo}/issues`;
  return `https://github.com/${issueRepo}`;
}

/**
 * 1件の開区間を走行中(endMs===null)の TimeEntry へ変換する。メタが引ければ
 * linkedItemId/itemType/title/url を補完し、引けなければ id を linkedItemId に流用して
 * `repo #issue` にフォールバックする(title は空文字にし、表示側で repo/number を出す)。
 * id は開区間の id をそのまま使う(ポーリングをまたいで安定するので React key に使える)。
 *
 * repo/number/url は「issue の所属 repo + 数値番号」で揃える(workLogIssueIdentity)。作業 repo と
 * issue の所属 repo が違う完全参照 (`owner/repo#12`) でも、メタ・表示・リンク先が同じ issue を
 * 指すようにするため ―― 開区間そのものの repo/issueRef は停止 (POST /api/work-logs/stop) 側が
 * openIntervals から直接読むので、ここで失われても支障は無い。
 */
export function openIntervalToTimeEntry(
  interval: OpenWorkIntervalDTO,
  lookup: Map<string, TimerItemMeta>,
): TimeEntry {
  const identity = workLogIssueIdentity(interval.repo, interval.issueRef);
  const number = issueIdentityNumber(identity);
  const meta = number !== undefined ? lookup.get(metaKey(identity.repo, number)) : undefined;
  return {
    id: interval.id,
    linkedItemId: meta?.linkedItemId ?? interval.id,
    itemType: meta?.itemType ?? "issue",
    title: meta?.title ?? "",
    repo: identity.repo,
    number: number ?? 0,
    url: meta?.url ?? fallbackUrl(identity.repo, number, identity.hasIssue),
    startMs: interval.startMs,
    endMs: null,
  };
}

/**
 * 開区間一覧を走行中 TimeEntry[] へ射影する。TimeEntryStore.replaceAll に渡して WeekGrid /
 * RunningTimersIndicator / 右ペイン(GitHubPane)の既存の走行表示を駆動する。
 */
export function openIntervalsToTimeEntries(
  intervals: readonly OpenWorkIntervalDTO[],
  plannedBlocks: readonly PlannedBlock[],
  queueItems: readonly GitHubWorkItemDTO[],
): TimeEntry[] {
  const lookup = buildTimerItemLookup(plannedBlocks, queueItems);
  return intervals.map((iv) => openIntervalToTimeEntry(iv, lookup));
}

/**
 * repo + number が実行中(対応する開区間がある)か。type は問わず repo+number(=issueRef)で
 * 判定する — 同一 repo+number が issue と PR の両方であることは実質無く、開区間側に type が
 * 無いため。▶/⏹ の出し分けと、二重 start を避ける事前チェックに使う。
 *
 * 開区間の issueRef は素の `12` と完全参照 `owner/repo#12` の2形態で来るので、両辺を
 * workLogIssueIdentity のキーへ正規化してから比較する(生文字列一致だと hook が完全参照で
 * 開始した開区間を取りこぼし、同じ issue に2本目の開区間ができてしまう)。
 */
export function isIntervalRunning(
  intervals: readonly OpenWorkIntervalDTO[],
  repo: string,
  number: number,
): boolean {
  const target = workLogIssueIdentity(repo, String(number)).key;
  return intervals.some((iv) => workLogIssueIdentity(iv.repo, iv.issueRef).key === target);
}

/**
 * ⏹ の停止リクエスト (POST /api/work-logs/stop) の body を組む
 * (リファクタリング フェーズ2 ⑤、2026-07-25 に hooks/useTimers.ts から切り出した純関数)。
 *
 * 射影 TimeEntry.id は開区間の id なので、まず元の開区間を引いて **開区間側の生の
 * repo/issueRef をそのまま送る** ―― 射影側の repo/number は workLogIssueIdentity で
 * 正規化済み(完全参照 `owner/repo#12` を issue の所属 repo + 数値に畳んだもの)なので、
 * それを送るとサーバー側の突き合わせ対象がずれる。
 *
 * 開区間が見つからない(ポーリングと表示のずれ等)場合だけ、射影が持つ repo/number から
 * フォールバックで組み立てる。number が 0(= 番号が取れなかった開区間の射影)なら
 * issueRef 自体を省く ―― `0` を送って別物に当てないため。開区間が見つかって issueRef を
 * 持たない場合も同じく省く(repo 単位の停止)。
 */
export function buildWorkIntervalStopRequest(
  intervals: readonly OpenWorkIntervalDTO[],
  running: { id: string; repo: string; number: number },
): WorkIntervalStopRequest {
  const interval = intervals.find((iv) => iv.id === running.id);
  const repo = interval?.repo ?? running.repo;
  const issueRef = interval
    ? interval.issueRef
    : running.number > 0
      ? String(running.number)
      : undefined;
  return { repo, ...(issueRef ? { issueRef } : {}) };
}
