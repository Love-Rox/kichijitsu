import type { Occurrence } from "../model/types";

/**
 * ドラッグ移動の確認ダイアログ (フェーズ2、2026-07-22) に関する純関数群。
 *
 * ドラッグ確定 (EventBlock.tsx の handlePointerUp) は「移動 (kind==='move')」と
 * 「リサイズ (kind==='resize')」の両方で WeekGrid.handleCommit を通るが、確認ダイアログを
 * 挟むのは移動のみ(ユーザー決定: リサイズは現状維持)。WeekGrid.handleCommit は
 * store.update で楽観的に即座に見た目へ反映してから、この判定で分岐する:
 *   - 時刻が実際に変わっていなければ(スナップ後に元の位置へ戻った等)、確認も
 *     永続化も不要(hasOccurrenceTimeChanged が false)。
 *   - 移動で実際に変わっていれば、確認ダイアログを挟む(App.tsx が state で保持し、
 *     MoveConfirmDialog.tsx を描画する)。「移動する」で従来どおり onPersist を呼び、
 *     「キャンセル」なら previous を store.update で書き戻すだけで良い ―― IndexedDB や
 *     Google への書き込みはまだ一切行っていない(onPersist を呼ぶ前)ため、
 *     ロールバックは store の巻き戻しのみで完結する。
 */

/** occurrence の時刻 (startMs/endMs) が実際に変わったか。ドラッグ/リサイズ共通で使う */
export function hasOccurrenceTimeChanged(previous: Occurrence, updated: Occurrence): boolean {
  return previous.startMs !== updated.startMs || previous.endMs !== updated.endMs;
}
