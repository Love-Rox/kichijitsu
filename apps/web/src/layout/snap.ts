/**
 * ドラッグ / リサイズ時のスナップポリシー。
 * デフォルトは 15 分グリッドへの丸め。将来ここに
 * 「近くの予定の端への磁石スナップ」「Alt でスナップ解除」等を足す。
 */

export const SNAP_MINUTES = 15;
export const SNAP_MS = SNAP_MINUTES * 60_000;

export interface SnapContext {
  /** ドラッグ開始時点の元の開始時刻 */
  originalStartMs: number;
  /** Alt キー等でスナップを無効化したいとき true（1分単位に落とす） */
  disableSnap?: boolean;
}

const MINUTE_MS = 60_000;

export function snapStartMs(rawStartMs: number, ctx: SnapContext): number {
  if (ctx.disableSnap) return Math.round(rawStartMs / MINUTE_MS) * MINUTE_MS;
  return Math.round(rawStartMs / SNAP_MS) * SNAP_MS;
}

/** リサイズ用: 終了時刻をスナップしつつ、最低 SNAP_MS の長さを保証する */
export function snapEndMs(rawEndMs: number, startMs: number, ctx: SnapContext): number {
  const snapped = ctx.disableSnap
    ? Math.round(rawEndMs / MINUTE_MS) * MINUTE_MS
    : Math.round(rawEndMs / SNAP_MS) * SNAP_MS;
  return Math.max(snapped, startMs + SNAP_MS);
}
