import type { Occurrence } from '../model/types'

/**
 * 同一予定(共有・複数アカウントへの招待コピー)の集約 (フェーズ5)。
 *
 * primary: 集約後にカードとして描画する代表 occurrence。グループ内で
 * accountId→calendarId の昇順ソートした先頭のコピー(「アカウント順で先頭」の
 * 決定的な代替実装 — WeekGrid はアカウントの連携順序を知らないため、
 * id 文字列の昇順を安定した代理指標として使う)。
 * ドラッグでの Google 書き戻しはこの primary の (accountId, calendarId) に
 * 対してのみ行われる(他メンバーの側の複製は動かない)。
 *
 * members: グループに属する全 occurrence(1件なら primary のみを含む配列)。
 * カード上の色ドット表示・詳細ポップオーバーの「全所属」列挙に使う。
 */
export interface OccurrenceGroup {
  primary: Occurrence
  members: Occurrence[]
}

/**
 * occurrences を iCalUID + startMs + endMs でグルーピングし、1グループ1カードに
 * まとめる。iCalUID が無い occurrence (再同期前の既存データ・ローカルイベント) は
 * 集約せず、常に単独グループとして扱う。
 * グループ内の並び順は accountId→calendarId 昇順に安定ソートする。
 */
export function groupDuplicateOccurrences(occurrences: readonly Occurrence[]): OccurrenceGroup[] {
  const groups = new Map<string, Occurrence[]>()

  for (const occ of occurrences) {
    const key = occ.iCalUID ? `uid:${occ.iCalUID}:${occ.startMs}:${occ.endMs}` : `single:${occ.id}`
    const members = groups.get(key)
    if (members) {
      members.push(occ)
    } else {
      groups.set(key, [occ])
    }
  }

  const result: OccurrenceGroup[] = []
  for (const members of groups.values()) {
    const sorted =
      members.length > 1
        ? [...members].sort(
            (a, b) =>
              (a.accountId ?? '').localeCompare(b.accountId ?? '') ||
              (a.calendarId ?? '').localeCompare(b.calendarId ?? ''),
          )
        : members
    result.push({ primary: sorted[0], members: sorted })
  }
  return result
}
