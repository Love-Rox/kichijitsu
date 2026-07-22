/**
 * 「不参加 (declined) の予定を表示しない」設定 (参加ステータス表示、2026-07-22)。
 * 左ペイン(CalendarPane)の「表示」セクションで ON/OFF する2つのチェックの状態をまとめた形。
 * IndexedDB meta への永続化は db/database.ts (hiddenTaskLists と同じ流儀: この端末だけの
 * ローカル設定、サーバー同期はしない) が担い、ここでは判定ロジックのみを純関数として持つ ――
 * WeekGrid/MonthView が visibleOccurrences/visibleAllDayOccurrences を組み立てる際にこの
 * フィルタを通すことで、AllDayBar・OOO レール(oooRail.ts が visibleOccurrences から
 * 不在分を切り出す)にも自動的に伝播する(要件: 「WeekGrid/MonthView/AllDayBar/OOO レール
 * 入力から除外」)。
 */
export interface DeclinedVisibilitySettings {
  /** 不参加の予定を表示するか。既定 true = 現状維持(ユーザー決定)。 */
  showDeclined: boolean;
  /**
   * showDeclined が false のときのサブオプション: 自分が主催 (isOrganizer) の予定は
   * declined でも表示に残すか。既定 true。showDeclined が true のときは無視される
   * (shouldHideDeclined 参照)。
   */
  keepOrganizerDeclined: boolean;
}

/** 未保存(初回起動)時の既定値。現状維持のため showDeclined は true。 */
export const DEFAULT_DECLINED_VISIBILITY: DeclinedVisibilitySettings = {
  showDeclined: true,
  keepOrganizerDeclined: true,
};

/** shouldHideDeclined が判定に使う最小限のフィールド。Occurrence/AllDayOccurrence 両方が構造的に満たす */
export interface DeclinedCheckSubject {
  responseStatus?: string;
  isOrganizer?: boolean;
}

/**
 * この occurrence/allDayOccurrence を表示から除外すべきか。
 *
 * declined 以外の responseStatus (accepted/tentative/needsAction/未設定) にはこのフィルタは
 * 一切関与しない(要件: 「不参加の非表示設定」であって参加ステータス全般のフィルタではない)。
 * showDeclined が true (既定) なら常に false を返す ―― 現状維持。showDeclined が false でも
 * keepOrganizerDeclined が true かつ自分が主催の予定なら残す(要件のサブオプション)。
 */
export function shouldHideDeclined(
  occ: DeclinedCheckSubject,
  settings: DeclinedVisibilitySettings,
): boolean {
  if (occ.responseStatus !== "declined") return false;
  if (settings.showDeclined) return false;
  if (settings.keepOrganizerDeclined && occ.isOrganizer) return false;
  return true;
}
