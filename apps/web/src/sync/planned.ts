import type { PlannedBlock } from "../model/types";
import { minutesToPx, pxToMinutes } from "../layout/gridMetrics";
import { snapEndMs, snapStartMs } from "../layout/snap";

/**
 * 予定タイムブロック (docs/github-integration.md「時間計測」増分1、2026-07-20) に関する
 * 純関数群。DOM/store に触れない副作用フリーの層としてここに切り出し、DayColumn.tsx
 * (ドロップでの新規作成)・PlannedBlock.tsx (移動/リサイズ)・App.tsx (upsert 用の
 * PlannedBlock 組み立て) から呼ぶ。sync/eventCreate.ts (Google 書き戻し版の新規作成) と
 * 対になるが、こちらは Google に一切書き戻さない前提のぶん単純。
 */

/** 作業キューのドラッグ元データ(HTML5 DnD の dataTransfer に載せる最小限の形) */
export interface DroppedWorkItem {
  id: string;
  type: "issue" | "pr";
  title: string;
  repo: string;
  number: number;
  url: string;
}

/** ドラッグ&ドロップで運ぶ dataTransfer の MIME タイプ(独自形式) */
export const WORKITEM_DND_MIME = "application/x-kichijitsu-workitem";

/** ドロップで作る予定ブロックの既定の長さ(縦ドラッグせずドロップしただけの場合) */
export const DEFAULT_PLANNED_DURATION_MS = 60 * 60_000;

/**
 * dataTransfer.getData(WORKITEM_DND_MIME) で取り出した生文字列を DroppedWorkItem に
 * 変換する。JSON.parse に失敗した/必須フィールドが欠けている場合は null を返す
 * (DOM の DataTransfer 自体はテストしづらいため、文字列を受け取る形に切り出してテスト可能にしてある)。
 */
export function parseDroppedWorkItem(raw: string | null | undefined): DroppedWorkItem | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.id !== "string" || d.id.length === 0) return null;
  if (d.type !== "issue" && d.type !== "pr") return null;
  if (typeof d.title !== "string") return null;
  if (typeof d.repo !== "string") return null;
  if (typeof d.number !== "number") return null;
  if (typeof d.url !== "string") return null;
  return { id: d.id, type: d.type, title: d.title, repo: d.repo, number: d.number, url: d.url };
}

/**
 * ドロップ位置(pointer の clientY、日列 DOM の getBoundingClientRect().top)から
 * 開始時刻を算出する(15分スナップ、DayColumn.tsx の beginCreateDrag と同じ座標変換)。
 */
export function computeDropStartMs(dayStartMs: number, clientY: number, columnTop: number): number {
  const rawMs = dayStartMs + pxToMinutes(clientY - columnTop) * 60_000;
  return snapStartMs(rawMs, { originalStartMs: rawMs });
}

/** ドロップされた作業アイテムと確定した時間帯から PlannedBlock を組み立てる */
export function buildPlannedBlock(
  item: DroppedWorkItem,
  startMs: number,
  endMs: number,
  nowMs: number = Date.now(),
): PlannedBlock {
  return {
    id: `plan:${item.id}:${nowMs}`,
    startMs,
    endMs,
    linkedItemId: item.id,
    itemType: item.type,
    title: item.title,
    repo: item.repo,
    number: item.number,
    url: item.url,
  };
}

/** その日の 0:00 からの px オフセット(EventBlock/DayColumn と同じ座標系) */
export function plannedBlockTopPx(startMs: number, dayStartMs: number): number {
  return minutesToPx((startMs - dayStartMs) / 60_000);
}

/** 最低 4px を保証した高さ(px) */
export function plannedBlockHeightPx(startMs: number, endMs: number): number {
  return Math.max(minutesToPx((endMs - startMs) / 60_000), 4);
}

/**
 * 移動ドラッグ確定用: rawStartMs をスナップし、元の長さを保ったまま新しい開始/終了時刻を返す
 * (EventBlock.tsx の move ドラッグと同じスナップ規則、Alt キーでスナップ解除可能)。
 */
export function computeMovedRange(
  rawStartMs: number,
  originalStartMs: number,
  durationMs: number,
  disableSnap = false,
): { startMs: number; endMs: number } {
  const startMs = snapStartMs(rawStartMs, { originalStartMs, disableSnap });
  return { startMs, endMs: startMs + durationMs };
}

/**
 * リサイズドラッグ確定用: rawEndMs をスナップし、最低 15分(SNAP_MS)の長さを保証する
 * (EventBlock.tsx の resize ドラッグと同じスナップ規則)。
 */
export function computeResizedEndMs(
  rawEndMs: number,
  startMs: number,
  originalStartMs: number,
  disableSnap = false,
): number {
  return snapEndMs(rawEndMs, startMs, { originalStartMs, disableSnap });
}
