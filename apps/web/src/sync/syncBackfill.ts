/**
 * 同期バックフィル対象の判定 (2026-07-22、旧 oooBackfill.ts の一般化)。
 *
 * 元々は eventType バックフィル (不在レール表示 a00fa80 導入前に同期済みだったイベントに
 * isOutOfOffice を行き渡らせる、一度きりの forceFull 同期) 専用のモジュールだった。RSVP 表示
 * (selfResponseStatus/isOrganizer/hasConference) の追加で「クライアント側だけで新フィールドを
 * 増やすたびに、過去に同期済みのイベントへ行き渡らせる必要がある」という同じ課題が再発したため、
 * boolean の「実施済みか」判定を世代番号の比較に一般化した(db/database.ts の
 * CURRENT_SYNC_BACKFILL_VERSION/getSyncBackfillVersion 参照)。
 *
 * ここでは「どのカレンダーを対象にすべきか」の判定だけを純関数として切り出す
 * (db/App.tsx の副作用 — IndexedDB 読み書き・fetch — から独立してテストするため)。
 */

export interface SyncBackfillTarget {
  accountId: string;
  calendarId: string;
}

/**
 * バックフィル対象の列挙。
 * - savedVersion が currentVersion 以上 (=既に追いついている) なら空配列 (再実行しない)
 * - 未達なら、現在選択中の全 (accountId, calendarId) をそのまま返す
 *
 * 世代が複数離れていても(例: 旧 boolean 移行直後の 1 → 現行 2 など)対象は常に選択中の
 * 全カレンダーのまま ―― 1回の forceFull 同期で最新の DTO 全フィールドが一気に届くため、
 * 世代ごとに個別のバックフィルを重ねて走らせる必要はない(常に「保存済み世代 → 現行世代」への
 * 1ジャンプとして扱う)。
 *
 * T を selectedTargets() の要素型 (WriteTargetCandidate、defaultColor/primary 等の
 * 付加情報を持つ) にも対応できるよう accountId/calendarId を持つ最小構造で受け取る
 * ジェネリクスにしてある — 呼び出し側 (App.tsx) は同期に必要な defaultColor 等を
 * 保ったまま渡せる。
 */
export function decideSyncBackfillTargets<T extends SyncBackfillTarget>(
  savedVersion: number,
  currentVersion: number,
  selectedTargets: readonly T[],
): readonly T[] {
  if (savedVersion >= currentVersion) return [];
  return selectedTargets;
}
