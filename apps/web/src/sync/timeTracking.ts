import type { PlannedBlock, TimeEntry } from "../model/types";

/**
 * 手動タイマー・予定 vs 実績レポート (docs/github-integration.md「時間計測」増分2、
 * 2026-07-20) に関する純関数群。DOM/store に触れない副作用フリーの層としてここに切り出し、
 * PlannedBlock.tsx (▶/⏹ ボタン)・App.tsx (onStartTimer/onStopTimer ハンドラ・レポート集計)・
 * RunningTimersIndicator.tsx/TimeReportOverlay.tsx (経過時間の表示整形) から呼ぶ。
 * sync/planned.ts (予定タイムブロックの純関数群) と対になるが、こちらは「実績」を扱う。
 *
 * **単一走行の制約は無い**(ユーザー要望、2026-07-20 仕様変更): 別々の linkedItemId なら
 * 同時に何本でも計測できる。同一 linkedItemId の二重走行だけを防ぐ不変条件は
 * store/timeEntryStore.ts (isRunning/getRunningEntries) 側が担い、この層は「1本のエントリ」を
 * 組み立てる/確定するだけの単純な関数に留める。
 */

/**
 * ▶/⏹ ボタンが必要とする最小限のアイテムメタ。PlannedBlock / GitHubWorkItemDTO はこれを
 * 構造的に満たす。実績 UX 刷新フェーズ5b(2026-07-23)以降、▶ 押下時に repo+number を
 * サーバーの start/stop API へ渡すためのアダプタとして使う。
 */
export interface TimerLinkedItem {
  linkedItemId: string;
  itemType: "issue" | "pr";
  title: string;
  repo: string;
  number: number;
  url: string;
}

/** 走行中は nowMs までの経過、確定済みは endMs-startMs をそのまま返す */
export function entryDurationMs(entry: TimeEntry, nowMs: number = Date.now()): number {
  const endMs = entry.endMs ?? nowMs;
  return Math.max(0, endMs - entry.startMs);
}

/** "2h 15m" / "45m" 形式。0分未満に丸まる端数は切り捨て */
export function formatDurationHm(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** 予定 vs 実績レポートの1行(item 単位) */
export interface ReportRow {
  linkedItemId: string;
  itemType: "issue" | "pr";
  title: string;
  repo: string;
  number: number;
  url: string;
  plannedMs: number;
  actualMs: number;
}

interface ItemMeta {
  linkedItemId: string;
  itemType: "issue" | "pr";
  title: string;
  repo: string;
  number: number;
  url: string;
}

/**
 * plannedBlocks(予定)と timeEntries(実績)を linkedItemId でグルーピングして突き合わせる。
 * 予定だけ/実績だけの item も行として含める(片方が0のまま出す)。アイテムメタ
 * (title/repo/number/url)は planned/entry のどちらか先に見つかった方から拾う
 * (増分1の PlannedBlock 側の非正規化と同じ考え方: どちらかが消えてもレポートは成立する)。
 * 並びは実績降順 → 予定降順 → タイトル昇順の安定順(実績が多い item を上に出す)。
 */
export function aggregatePlannedVsActual(
  plannedBlocks: PlannedBlock[],
  timeEntries: TimeEntry[],
  nowMs: number = Date.now(),
): ReportRow[] {
  const rows = new Map<string, ReportRow>();

  function ensure(meta: ItemMeta): ReportRow {
    const existing = rows.get(meta.linkedItemId);
    if (existing) return existing;
    const row: ReportRow = { ...meta, plannedMs: 0, actualMs: 0 };
    rows.set(meta.linkedItemId, row);
    return row;
  }

  for (const block of plannedBlocks) {
    const row = ensure(block);
    row.plannedMs += block.endMs - block.startMs;
  }
  for (const entry of timeEntries) {
    const row = ensure(entry);
    row.actualMs += entryDurationMs(entry, nowMs);
  }

  return [...rows.values()].sort(
    (a, b) =>
      b.actualMs - a.actualMs || b.plannedMs - a.plannedMs || a.title.localeCompare(b.title),
  );
}
