/**
 * 左ペイン(CalendarPane)のグループ折りたたみ(マイカレンダー/他のカレンダー/タスクリスト、
 * 2026-07-22)の DOM/React に依存しない純関数層。既存のアカウント折りたたみ
 * (CalendarPane.tsx の loadCollapsedAccounts/saveCollapsedAccounts、キー=accountId 単独)と
 * 同じ localStorage 永続の流儀を踏襲しつつ、グループはアカウント内に複数種類あるため
 * `${accountId}:${kind}` の複合キーにする ―― kind ごとに別の Set を持たず、1つの Set に
 * 全アカウント・全種別の折りたたみ済みキーをまとめて入れる(アカウント折りたたみと同じ設計)。
 *
 * localStorage の読み書き自体(loadCollapsedGroups/saveCollapsedGroups)は副作用を持つため
 * CalendarPane.tsx 側に残し(現在は layout/localStore.ts の共通ラッパー経由)、ここでは
 * キー生成という純粋な部分だけを切り出してテストしやすくする
 * (groupDuplicates.ts/monthGrid.ts と同じ流儀)。
 *
 * かつてここにあった toggleSetMember は layout/setOps.ts へ移した(2026-07-25) ――
 * setOps 側の addToSet/removeFromSet と役割が重複しており「どちらを使うのか」が
 * 曖昧だったため、Set 操作は setOps.ts に一本化した。
 */

/** 折りたたみ対象のグループ種別。CalendarPane.tsx の AccountSection 内にある3グループに対応する */
export type CalendarPaneGroupKind = "mine" | "others" | "tasks";

/** 折りたたみ集合のキー規則: `${accountId}:${kind}` */
export function calendarPaneGroupKey(accountId: string, kind: CalendarPaneGroupKind): string {
  return `${accountId}:${kind}`;
}
