/**
 * 「どの期間ぶんの occurrence を事前展開しておくか」のポリシー。
 * ストレージ量・展開コストと、スクロール時に未展開領域を踏む確率の
 * トレードオフを一手に引き受ける場所。
 */

export const DAY_MS = 86_400_000;

/** IndexedDB の meta ストアに保存されている、現在展開済みの範囲 */
export interface ExpansionState {
  expandedFromMs: number;
  expandedToMs: number;
}

export interface WindowDecision {
  /** false なら展開不要（表示範囲は十分カバーされている） */
  needsExpand: boolean;
  /** 展開すべき新しい範囲。既存範囲を包含するように広げること（縮めない） */
  fromMs: number;
  toMs: number;
}

/** 初回・追加展開のチャンク幅: 1年 (2026-07-19 ユーザー決定「いったん前後1年」) */
export const CHUNK_MS = 365 * DAY_MS;
/** 展開済み境界からこの距離以内に表示範囲が入ったら追加展開する */
export const MARGIN_MS = 90 * DAY_MS;

/**
 * 表示中の範囲 [visibleStartMs, visibleEndMs) と現在の展開状態から、
 * 追加展開が必要か・どこまで展開するかを決める。
 *
 * ポリシー: 初回は now±1年。以後、表示範囲が境界の 90 日以内に入ったら
 * その方向へ 1 年ぶん広げる（「毎回少しずつ」より「たまに大きく」）。
 * ジャンプ移動で展開範囲を大きく外れた場合も表示範囲+マージンまで一気に広げる。
 * 返す範囲は常に既存範囲を包含する（縮めない）。
 */
export function decideExpansionWindow(
  visibleStartMs: number,
  visibleEndMs: number,
  state: ExpansionState | null,
  nowMs: number,
): WindowDecision {
  if (state === null) {
    return { needsExpand: true, fromMs: nowMs - CHUNK_MS, toMs: nowMs + CHUNK_MS };
  }
  let fromMs = state.expandedFromMs;
  let toMs = state.expandedToMs;
  if (visibleStartMs < fromMs + MARGIN_MS) {
    fromMs = Math.min(fromMs - CHUNK_MS, visibleStartMs - MARGIN_MS);
  }
  if (visibleEndMs > toMs - MARGIN_MS) {
    toMs = Math.max(toMs + CHUNK_MS, visibleEndMs + MARGIN_MS);
  }
  const needsExpand = fromMs !== state.expandedFromMs || toMs !== state.expandedToMs;
  return { needsExpand, fromMs, toMs };
}
