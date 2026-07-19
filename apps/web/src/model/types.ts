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
}
