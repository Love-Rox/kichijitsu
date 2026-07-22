/**
 * eventType 一度きりバックフィル (2026-07-22)。不在レール表示 (a00fa80) 導入前に
 * 同期済みだったイベントには、Google の eventType==='outOfOffice' から導出する
 * isOutOfOffice フラグが永久に付かない — 変更の無いイベントは増分同期で再配信されない
 * ため (docs 未整備、App.tsx handleToggleCalendar のコメントおよび設計の前提を参照)。
 * これを解消するため、初回起動時に一度だけ選択中の全カレンダーを forceFull: true で
 * 同期し直す (App.tsx の runOooBackfillIfNeeded)。
 *
 * ここでは「どのカレンダーを対象にすべきか」の判定だけを純関数として切り出す
 * (db/App.tsx の副作用 — IndexedDB 読み書き・fetch — から独立してテストするため)。
 */

export interface OooBackfillTarget {
  accountId: string;
  calendarId: string;
}

/**
 * バックフィル対象の列挙。
 * - 既に完了済み (alreadyDone) なら空配列 (再実行しない)
 * - 未実施なら、現在選択中の全 (accountId, calendarId) をそのまま返す
 *
 * T を selectedTargets() の要素型 (WriteTargetCandidate、defaultColor/primary 等の
 * 付加情報を持つ) にも対応できるよう accountId/calendarId を持つ最小構造で受け取る
 * ジェネリクスにしてある — 呼び出し側 (App.tsx) は同期に必要な defaultColor 等を
 * 保ったまま渡せる。
 */
export function decideOooBackfillTargets<T extends OooBackfillTarget>(
  alreadyDone: boolean,
  selectedTargets: readonly T[],
): readonly T[] {
  if (alreadyDone) return [];
  return selectedTargets;
}
