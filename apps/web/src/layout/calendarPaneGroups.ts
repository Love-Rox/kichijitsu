/**
 * 左ペイン(CalendarPane)のグループ折りたたみ(マイカレンダー/他のカレンダー/タスクリスト、
 * 2026-07-22)の DOM/React に依存しない純関数層。既存のアカウント折りたたみ
 * (CalendarPane.tsx の loadCollapsedAccounts/saveCollapsedAccounts、キー=accountId 単独)と
 * 同じ localStorage 永続の流儀を踏襲しつつ、グループはアカウント内に複数種類あるため
 * `${accountId}:${kind}` の複合キーにする ―― kind ごとに別の Set を持たず、1つの Set に
 * 全アカウント・全種別の折りたたみ済みキーをまとめて入れる(アカウント折りたたみと同じ設計)。
 *
 * localStorage の読み書き自体(loadCollapsedGroups/saveCollapsedGroups)は副作用を持つため
 * CalendarPane.tsx 側に残し、ここではキー生成・Set 操作という純粋な部分だけを切り出して
 * テストしやすくする(groupDuplicates.ts/monthGrid.ts と同じ流儀)。
 */

/** 折りたたみ対象のグループ種別。CalendarPane.tsx の AccountSection 内にある3グループに対応する */
export type CalendarPaneGroupKind = "mine" | "others" | "tasks";

/** 折りたたみ集合のキー規則: `${accountId}:${kind}` */
export function calendarPaneGroupKey(accountId: string, kind: CalendarPaneGroupKind): string {
  return `${accountId}:${kind}`;
}

/**
 * Set の要素をトグルした新しい Set を返す(React の setState 用、引数の Set 自体は変更しない)。
 * アカウント折りたたみ (CalendarPane.tsx の toggleAccountCollapsed) が持つのと同じロジックだが、
 * こちらはグループ折りたたみからも同じ形で再利用できるよう独立した純関数にしてある。
 */
export function toggleSetMember(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}
