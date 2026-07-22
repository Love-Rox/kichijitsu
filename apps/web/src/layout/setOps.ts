/**
 * React の setState 用の Set 追加・削除ヘルパー(DOM/React に依存しない純関数層)。
 * calendarPaneGroups.ts の toggleSetMember と同じ「引数の Set は変更せず新しい Set を返す」
 * 流儀だが、こちらは「変化が無ければ同じ参照をそのまま返す」点が異なる ―― 既に入っている
 * 要素を add したり、入っていない要素を delete したりしても新しい Set を作らないので、
 * setState に渡しても React が無駄な再レンダーを起こさない(tasksScopeMissingAccounts の
 * 403 検知で毎回同じ id を add し続けても状態が安定する、App.tsx 参照)。
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
