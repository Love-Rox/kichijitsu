/** occurrence の出自。UI はソースをほぼ意識せず、source と link だけで扱う */
export type OccurrenceSource = 'local' | 'google' | 'github'

/** クリックで元リソース（GitHub の PR 等）へ飛ぶための参照 */
export interface OccurrenceLink {
  url: string
  label?: string
}

/**
 * 展開済み occurrence。IndexedDB に入る最小単位で、UI はこれだけを読む。
 * 時刻は epoch ms (UTC instant) — IndexedDB の範囲インデックスは数値が最速。
 * タイムゾーン変換は表示層で Temporal を使って行う。
 */
export interface Occurrence {
  id: string
  /** 繰り返しシリーズ由来なら親 series の id、単発なら null */
  seriesId: string | null
  title: string
  startMs: number
  endMs: number
  color: string
  source: OccurrenceSource
  link?: OccurrenceLink
  /**
   * シリーズ由来の場合のみ: 展開時の元の開始時刻 (epoch ms)。
   * ドラッグ等で startMs が変わっても不変で、InstanceOverride との対応付けに使う
   */
  originalStartMs?: number
}

/** 終日予定は時刻を持たない日付として別レイヤーで扱う（UTC変換に巻き込まない） */
export interface AllDayOccurrence {
  id: string
  seriesId: string | null
  title: string
  /** ISO 8601 calendar date, e.g. "2026-07-19" */
  startDate: string
  endDate: string
  color: string
  source: OccurrenceSource
  link?: OccurrenceLink
}
