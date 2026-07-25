/**
 * マルチアカウント前提の複合キー(`${accountId}:${...Id}`)の生成を1箇所に集める。
 *
 * なぜ: 選択中カレンダーの集合・カレンダー色の lookup・SSE の debounce キー・同期の直列化キー・
 * タスクリストの非表示集合など、同じ文字列規則をテンプレートリテラルで手書きしている箇所が
 * 15箇所前後あった。区切り文字を1文字変えるだけで全機能が静かに壊れる類の規則なので、
 * calendarPaneGroups.ts の calendarPaneGroupKey(`${accountId}:${kind}`)と同じ考え方で
 * 関数にして出どころを1つにする。
 *
 * 注意: accountId / calendarId / taskListId のいずれも ":" を含まない前提の単純結合
 * (Google の id は URL 安全な文字列なので実運用では衝突しない)。逆変換が必要な箇所
 * (BlockRulesOverlay の splitKey)は最初の ":" で分割している ―― accountId 側に ":" を
 * 含めない前提はここと共通。
 */

/** 選択中カレンダー集合・カレンダー色 lookup・同期直列化などで使う (accountId, calendarId) キー */
export function calendarKey(accountId: string, calendarId: string): string {
  return `${accountId}:${calendarId}`;
}

/**
 * Occurrence / AllDayOccurrence から calendarKey を作る版。
 *
 * これらの型では accountId / calendarId が optional(ローカル由来の予定は持たない)なため、
 * 呼び出し側は「Google 由来か」を先に判定してからこれを呼ぶ前提
 * (WeekGrid / MonthView の `o.source !== "google" || visibleCalendarKeys.has(...)` の右辺)。
 * 万一 undefined が来ても、選択キー集合のどれにも一致しない文字列になるだけで
 * 照合が false になる ―― 置き換え前のテンプレートリテラル("undefined:undefined")と
 * 同じく「一致しない」挙動を保つ。
 */
export function calendarKeyOf(target: { accountId?: string; calendarId?: string }): string {
  return calendarKey(target.accountId ?? "", target.calendarId ?? "");
}

/**
 * (accountId, taskListId) キー。calendarKey と文字列形は同じだが、混ぜてはいけない別の集合
 * (hiddenTaskLists / autoSyncedTaskLists)のキーなので関数を分けてある ―― 呼び出し箇所を
 * grep したときに「どちらの集合の話か」が読めるようにするため。
 */
export function taskListKey(accountId: string, taskListId: string): string {
  return `${accountId}:${taskListId}`;
}
