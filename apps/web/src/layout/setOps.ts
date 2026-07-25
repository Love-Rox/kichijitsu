/**
 * React の setState 用の Set 追加・削除・トグルヘルパー(DOM/React に依存しない純関数層)。
 * どれも「引数の Set は変更せず新しい Set を返す」流儀だが、add/remove は
 * **変化が無ければ同じ参照をそのまま返す**のが要点 ―― 既に入っている要素を add したり、
 * 入っていない要素を delete したりしても新しい Set を作らないので、setState に渡しても
 * React が無駄な再レンダーを起こさない(tasksScopeMissingAccounts の 403 検知で毎回同じ id を
 * add し続けても状態が安定する、App.tsx 参照)。
 *
 * 2026-07-25 の共通化: 以前は layout/calendarPaneGroups.ts にも toggleSetMember という
 * ほぼ同じ役割の関数があり、「どちらを使うべきか」が曖昧だった(setOps 自身のコメントが
 * その競合を自認していた)。Set 操作はこのモジュールに一本化し、calendarPaneGroups.ts は
 * キー生成(calendarPaneGroupKey)だけを持つようにした。
 */

/** key を含む新しい Set を返す。既に含むなら同じ参照をそのまま返す(再レンダー抑制) */
export function addToSet(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (set.has(key)) return set;
  const next = new Set(set);
  next.add(key);
  return next;
}

/** key を除いた新しい Set を返す。元々含まないなら同じ参照をそのまま返す(再レンダー抑制) */
export function removeFromSet(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (!set.has(key)) return set;
  const next = new Set(set);
  next.delete(key);
  return next;
}

/**
 * key の有無をトグルした新しい Set を返す(引数の Set 自体は変更しない)。
 * 折りたたみ状態(CalendarPane のアカウント/グループ)やチェックボックス群
 * (BlockRulesOverlay の source 選択)のように「押したら必ず反転する」操作用。
 *
 * add/remove と違い必ず新しい Set になる ―― トグルは定義上いつも内容が変わるため、
 * 同一参照を返す余地が無い。戻り値を Set<string> にしてあるのは、呼び出し側が
 * そのまま localStorage へ保存(writeStoredStringSet)したり state に入れたりできるようにするため。
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
