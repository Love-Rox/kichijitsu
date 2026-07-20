import { Temporal } from '@js-temporal/polyfill'
import type { AllDayOccurrence, Occurrence } from '../model/types'

/**
 * 予定検索(フェーズ6)。DOM/React に依存しない純粋関数として切り出し、単体テストしやすくしてある。
 * 呼び出し側 (SearchOverlay.tsx) は IndexedDB から全件を読み出し(store は展開ウィンドウ内のみで
 * 全期間検索には使えないため)、この関数へそのまま渡す想定。
 */

/** 開始時刻順に並べるための共通ソートキー(epoch ms)を持たせた検索結果。時刻予定/終日予定を区別できる判別共用体 */
export type SearchResultItem =
  | { kind: 'timed'; occurrence: Occurrence; sortMs: number }
  | { kind: 'allDay'; occurrence: AllDayOccurrence; sortMs: number }

export interface SearchOccurrencesOptions {
  /**
   * `${accountId}:${calendarId}` の集合。指定された場合、Google 由来 (accountId/calendarId を
   * 持つ) 予定はこの集合に含まれるものだけを対象にする(WeekGrid/MonthView と同じ
   * 「ローカルデータは常に表示、Google は選択中カレンダーのみ」の規則)。未指定ならフィルタしない。
   */
  visibleCalendarKeys?: Set<string>
  /** クエリありの一致件数の上限。既定 50 */
  limit?: number
  /** 空クエリ時に返す「近日の予定」の件数上限。既定 8 */
  emptyQueryLimit?: number
  /** 「現在時刻」。空クエリ時の近日判定・テストで固定値を注入するために使う。既定 Date.now() */
  now?: number
}

const DEFAULT_LIMIT = 50
const DEFAULT_EMPTY_QUERY_LIMIT = 8

/** 終日予定の startDate (YYYY-MM-DD) を並び替え専用の UTC 深夜 ms に変換する(表示には使わない) */
function allDayStartSortMs(startDate: string): number {
  const [y, m, d] = startDate.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

/**
 * 大文字小文字・全角/半角の差を最小限吸収した正規化。NFKC で全角英数記号/半角カナを
 * 半角/全角の正準形へ寄せてから小文字化する(完全な仮名遣い正規化ではない、最小対応)。
 */
function normalize(s: string): string {
  return s.normalize('NFKC').toLowerCase()
}

function passesVisibility(
  target: { accountId?: string; calendarId?: string },
  visibleCalendarKeys: Set<string> | undefined,
): boolean {
  if (!visibleCalendarKeys) return true
  if (target.accountId === undefined || target.calendarId === undefined) return true // ローカルデータは常に対象
  return visibleCalendarKeys.has(`${target.accountId}:${target.calendarId}`)
}

function matchesQuery(occurrence: { title: string; location?: string; description?: string }, normalizedQuery: string): boolean {
  const haystacks = [occurrence.title, occurrence.location, occurrence.description]
  for (const h of haystacks) {
    if (h && normalize(h).includes(normalizedQuery)) return true
  }
  return false
}

/**
 * タイトル・場所・説明の部分一致で予定を検索し、開始時刻の昇順(上限件数まで)で返す。
 * クエリが空文字(トリム後)の場合は一致検索をせず、現在時刻付近の予定を数件返す
 * (直近の過去で埋め合わせつつ、近日の予定を優先して見せる)。
 */
export function searchOccurrences(
  query: string,
  occurrences: readonly Occurrence[],
  allDay: readonly AllDayOccurrence[],
  opts: SearchOccurrencesOptions = {},
): SearchResultItem[] {
  const limit = opts.limit ?? DEFAULT_LIMIT
  const now = opts.now ?? Date.now()
  const visibleCalendarKeys = opts.visibleCalendarKeys

  const items: SearchResultItem[] = []
  for (const o of occurrences) {
    if (!passesVisibility(o, visibleCalendarKeys)) continue
    items.push({ kind: 'timed', occurrence: o, sortMs: o.startMs })
  }
  for (const o of allDay) {
    if (!passesVisibility(o, visibleCalendarKeys)) continue
    items.push({ kind: 'allDay', occurrence: o, sortMs: allDayStartSortMs(o.startDate) })
  }

  const normalizedQuery = normalize(query.trim())

  if (normalizedQuery === '') {
    const emptyLimit = opts.emptyQueryLimit ?? DEFAULT_EMPTY_QUERY_LIMIT
    const upcoming = items.filter((it) => it.sortMs >= now).sort((a, b) => a.sortMs - b.sortMs)
    if (upcoming.length >= emptyLimit) return upcoming.slice(0, emptyLimit)
    // 近日の予定が足りない場合は、直近の過去から時系列順になるよう埋め合わせる
    const past = items
      .filter((it) => it.sortMs < now)
      .sort((a, b) => b.sortMs - a.sortMs)
      .slice(0, emptyLimit - upcoming.length)
      .reverse()
    return [...past, ...upcoming]
  }

  return items
    .filter((it) => matchesQuery(it.occurrence, normalizedQuery))
    .sort((a, b) => a.sortMs - b.sortMs)
    .slice(0, limit)
}

/**
 * 検索結果1件から、SearchOverlay.tsx が App.tsx へ「この日へジャンプしたい」ことだけを
 * 伝える最小の形。時刻予定/終日予定でジャンプ先日付の求め方が異なる(前者は epoch ms、
 * 後者は壁時計の日付文字列)ため判別共用体にしてある。
 * SearchOverlay.tsx (React コンポーネント) と同じファイルに置くと oxlint の
 * react(only-export-components) 警告に触れるため、EventBlock.tsx/eventPopoverShared.ts と
 * 同じ流儀でロジックだけこちらへ切り出してある。
 */
export type SearchJumpTarget = { kind: 'timed'; startMs: number } | { kind: 'allDay'; startDate: string }

/**
 * 検索結果からジャンプ先日付を求める(App.tsx から使う純粋関数)。時刻予定は timeZone の
 * 壁時計に変換した日付、終日予定は startDate をそのまま Temporal.PlainDate にする。
 */
export function resolveJumpDate(target: SearchJumpTarget, timeZone: string): Temporal.PlainDate {
  return target.kind === 'timed'
    ? Temporal.Instant.fromEpochMilliseconds(target.startMs).toZonedDateTimeISO(timeZone).toPlainDate()
    : Temporal.PlainDate.from(target.startDate)
}
