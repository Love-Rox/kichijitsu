import type { GitHubWorkItemDTO, OpenWorkIntervalDTO } from "@kichijitsu/shared";
import type { PlannedBlock, TimeEntry } from "../model/types";

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
 */

interface TimerItemMeta {
  /** 走行判定・WorkLogModal/WeekGrid のハイライトに使う。PlannedBlock.linkedItemId と同体系 */
  linkedItemId: string;
  itemType: "issue" | "pr";
  title: string;
  url: string;
}

function metaKey(repo: string, number: number | string): string {
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

/** issue/PR どちらでも /issues/N で開ける(PR は GitHub が /pull/N へリダイレクトする)。 */
function fallbackUrl(repo: string, issueRef: string | undefined): string {
  if (!issueRef) return `https://github.com/${repo}`;
  return `https://github.com/${repo}/issues/${issueRef}`;
}

/**
 * 1件の開区間を走行中(endMs===null)の TimeEntry へ変換する。メタが引ければ
 * linkedItemId/itemType/title/url を補完し、引けなければ id を linkedItemId に流用して
 * `repo #issue` にフォールバックする(title は空文字にし、表示側で repo/number を出す)。
 * id は開区間の id をそのまま使う(ポーリングをまたいで安定するので React key に使える)。
 */
export function openIntervalToTimeEntry(
  interval: OpenWorkIntervalDTO,
  lookup: Map<string, TimerItemMeta>,
): TimeEntry {
  const meta = interval.issueRef
    ? lookup.get(metaKey(interval.repo, interval.issueRef))
    : undefined;
  const parsed = interval.issueRef ? Number(interval.issueRef) : 0;
  const number = Number.isFinite(parsed) ? parsed : 0;
  return {
    id: interval.id,
    linkedItemId: meta?.linkedItemId ?? interval.id,
    itemType: meta?.itemType ?? "issue",
    title: meta?.title ?? "",
    repo: interval.repo,
    number,
    url: meta?.url ?? fallbackUrl(interval.repo, interval.issueRef),
    startMs: interval.startMs,
    endMs: null,
  };
}

/**
 * 開区間一覧を走行中 TimeEntry[] へ射影する。TimeEntryStore.replaceAll に渡して WeekGrid /
 * RunningTimersIndicator / WorkLogModal の既存の走行表示を駆動する。
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
 * 無いため。▶/⏹ の出し分けに使う。
 */
export function isIntervalRunning(
  intervals: readonly OpenWorkIntervalDTO[],
  repo: string,
  number: number,
): boolean {
  const ref = String(number);
  return intervals.some((iv) => iv.repo === repo && (iv.issueRef ?? "") === ref);
}
