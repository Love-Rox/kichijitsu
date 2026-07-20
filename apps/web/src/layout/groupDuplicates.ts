import type { AllDayOccurrence, Occurrence } from '../model/types'

/**
 * 同一予定(共有・複数アカウントへの招待コピー)の集約 (フェーズ5)。
 * 時刻予定 (Occurrence) と終日予定 (AllDayOccurrence) の両方で同じ考え方を使うため、
 * グルーピング本体は groupByKey に共通化し、キーの作り方だけを型ごとに変える。
 *
 * primary: 集約後にカードとして描画する代表 occurrence。グループ内で
 * accountId→calendarId の昇順ソートした先頭のコピー(「アカウント順で先頭」の
 * 決定的な代替実装 — WeekGrid はアカウントの連携順序を知らないため、
 * id 文字列の昇順を安定した代理指標として使う)。
 * ドラッグでの Google 書き戻しはこの primary の (accountId, calendarId) に
 * 対してのみ行われる(他メンバーの側の複製は動かない。終日は表示専用でドラッグ対象外)。
 *
 * members: グループに属する全 occurrence(1件なら primary のみを含む配列)。
 * カード上の色ドット表示・詳細ポップオーバーの「全所属」列挙に使う。
 */
export interface OccurrenceGroup {
  primary: Occurrence
  members: Occurrence[]
}

export interface AllDayOccurrenceGroup {
  primary: AllDayOccurrence
  members: AllDayOccurrence[]
}

/** accountId→calendarId 昇順の比較関数。両方の型で共通(構造的に同じフィールドを持つ) */
function compareByAccountThenCalendar(a: { accountId?: string; calendarId?: string }, b: typeof a): number {
  return (a.accountId ?? '').localeCompare(b.accountId ?? '') || (a.calendarId ?? '').localeCompare(b.calendarId ?? '')
}

/**
 * items を keyOf が返すグルーピングキーでまとめる汎用ヘルパー。
 * keyOf が undefined を返す item (集約キーが無いもの) は集約せず、
 * fallbackKeyOf (通常は id) で単独グループのキーを作る。
 */
function groupByKey<T extends { accountId?: string; calendarId?: string }>(
  items: readonly T[],
  keyOf: (item: T) => string | undefined,
  fallbackKeyOf: (item: T) => string,
): { primary: T; members: T[] }[] {
  const groups = new Map<string, T[]>()

  for (const item of items) {
    const uidKey = keyOf(item)
    const key = uidKey !== undefined ? `uid:${uidKey}` : `single:${fallbackKeyOf(item)}`
    const members = groups.get(key)
    if (members) {
      members.push(item)
    } else {
      groups.set(key, [item])
    }
  }

  const result: { primary: T; members: T[] }[] = []
  for (const members of groups.values()) {
    const sorted = members.length > 1 ? [...members].sort(compareByAccountThenCalendar) : members
    result.push({ primary: sorted[0], members: sorted })
  }
  return result
}

/**
 * occurrences を iCalUID + startMs + endMs でグルーピングし、1グループ1カードに
 * まとめる。iCalUID が無い occurrence (再同期前の既存データ・ローカルイベント) は
 * 集約せず、常に単独グループとして扱う。
 */
export function groupDuplicateOccurrences(occurrences: readonly Occurrence[]): OccurrenceGroup[] {
  return groupByKey(
    occurrences,
    (o) => (o.iCalUID ? `${o.iCalUID}:${o.startMs}:${o.endMs}` : undefined),
    (o) => o.id,
  )
}

/**
 * 終日予定版。iCalUID + startDate + endDate (共に inclusive な日付文字列) で
 * グルーピングする。時刻予定と同じく iCalUID が無ければ単独グループのまま
 */
export function groupDuplicateAllDayOccurrences(
  items: readonly AllDayOccurrence[],
): AllDayOccurrenceGroup[] {
  return groupByKey(
    items,
    (o) => (o.iCalUID ? `${o.iCalUID}:${o.startDate}:${o.endDate}` : undefined),
    (o) => o.id,
  )
}
