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
  /**
   * true なら color はイベント個別色 (Google の colorId 由来) で、表示時も
   * そのまま使う。false/undefined なら color は同期時点のフォールバック焼き込み値
   * に過ぎず、表示は calendarLookup のカレンダー色を優先する
   * (layout/eventColors.ts の resolveDisplayColor 参照)
   */
  hasCustomColor?: boolean
  source: OccurrenceSource
  link?: OccurrenceLink
  /**
   * シリーズ由来の場合のみ: 展開時の元の開始時刻 (epoch ms)。
   * ドラッグ等で startMs が変わっても不変で、InstanceOverride との対応付けに使う
   */
  originalStartMs?: number
  /** Google 由来のみ: どのアカウントのどのカレンダーか。表示トグルと削除の単位 */
  accountId?: string
  calendarId?: string
  /** 同一予定の集約キー (Google iCalUID)。共有・招待の重複表示をまとめる */
  iCalUID?: string
  /** ホバー/詳細表示用。location は会議室・住所・URL 等 */
  location?: string
  description?: string
}

/**
 * 終日予定は時刻を持たない日付として別レイヤーで扱う（UTC変換に巻き込まない）。
 * startDate/endDate は ISO 8601 calendar date (YYYY-MM-DD) の文字列で、
 * 両端 inclusive (endDate 当日を含む) — Google の end.date は排他的だが、
 * mapGoogle が取り込み時に inclusive へ正規化してここに格納する。
 */
export interface AllDayOccurrence {
  id: string
  /** 繰り返しシリーズ由来なら親 series の id。終日の繰り返しは初版未対応のため常に null */
  seriesId: string | null
  title: string
  /** ISO 8601 calendar date, e.g. "2026-07-19" (開始日、inclusive) */
  startDate: string
  /** ISO 8601 calendar date (終了日、inclusive。単日イベントは startDate と同じ) */
  endDate: string
  color: string
  /** Occurrence.hasCustomColor と同じ意味 (resolveDisplayColor 参照) */
  hasCustomColor?: boolean
  source: OccurrenceSource
  link?: OccurrenceLink
  /** Google 由来のみ: どのアカウントのどのカレンダーか。表示トグルと削除の単位 */
  accountId?: string
  calendarId?: string
  /** 同一予定の集約キー (Google iCalUID)。共有・招待の重複表示をまとめる */
  iCalUID?: string
  /** ホバー/詳細表示用 */
  location?: string
  description?: string
}

/**
 * Google タスク (docs/google-tasks.md、2026-07-20)。due は日付精度のみ有効
 * (時刻は Google API 側で捨てられる) なので、AllDayOccurrence と同様に
 * 日付レーンに表示する — が、タスクは繰り返し・複数日にまたがることがなく
 * 完了状態を持つ点が終日予定と違うため、別の軽量な型として持つ。
 *
 * id 規則: `t:<accountId>:<taskListId>:<taskId>` (mapGoogle 系の `g:...` と同じ思想)。
 * accountId/taskListId は id から再パースせず、フィールドとしてそのまま持つ
 * (書き戻し・表示トグルの両方でそのまま使えるようにするため)。
 */
export interface TaskItem {
  id: string
  accountId: string
  taskListId: string
  title: string
  /** ISO 8601 calendar date (YYYY-MM-DD)。due 無しタスクは null (v1 は日付レーンに表示しない) */
  dueDate: string | null
  status: 'needsAction' | 'completed'
  notes?: string
}
