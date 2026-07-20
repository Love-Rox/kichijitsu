import type { VisibleCalendarsRequest } from '@kichijitsu/shared'

/** account_visible_calendars テーブルの1行 (GET 集約の入力にも PUT 全置換の出力にも使う)。 */
export interface VisibleCalendarRow {
  account_id: string
  calendar_id: string
  created_at: number
}

/** account_calendar_prefs テーブルの1行。 */
export interface CalendarPrefsRow {
  account_id: string
  configured: number
  updated_at: number
}

/**
 * GET /api/me: プロファイルに属する全アカウントのうち「選択を設定済み (configured)」な
 * アカウントだけ、MeResponse.visibleCalendars にエントリを含める。
 * - configured だが選択0件 → 空配列を含める
 * - configured でない (account_calendar_prefs に行が無い) → キーごと省略する
 *   (クライアント側で primary をデフォルト選択する余地を残すため)
 *
 * `visibleRows` に configured でないアカウントの行が (レース等で) 混入していても、
 * `configuredAccountIds` にキーが無ければ黙って無視する (呼び出し元は2つのクエリの
 * 結果をそのまま渡せばよく、突き合わせをここで完結させる)。
 */
export function aggregateVisibleCalendars(
  configuredAccountIds: Iterable<string>,
  visibleRows: Pick<VisibleCalendarRow, 'account_id' | 'calendar_id'>[],
): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const accountId of configuredAccountIds) {
    result[accountId] = []
  }
  for (const row of visibleRows) {
    const bucket = result[row.account_id]
    if (bucket) {
      bucket.push(row.calendar_id)
    }
  }
  return result
}

/**
 * PUT /api/visible-calendars のボディ検証。accountId は非空文字列、calendarIds は
 * 文字列の配列であること (空配列は許容 = 「全部外した」意思を表す正当な入力)。
 */
export function isValidVisibleCalendarsRequest(body: unknown): body is VisibleCalendarsRequest {
  if (!body || typeof body !== 'object') return false
  const candidate = body as Record<string, unknown>
  return (
    typeof candidate.accountId === 'string' &&
    candidate.accountId.length > 0 &&
    Array.isArray(candidate.calendarIds) &&
    candidate.calendarIds.every((id) => typeof id === 'string')
  )
}

/**
 * PUT /api/visible-calendars: 全置換 (DELETE→INSERT) で新規挿入する行を組み立てる。
 * 重複した calendarId は1つにまとめる (Set で正規化) — DB 側の PK (account_id,
 * calendar_id) 制約と整合させ、INSERT の衝突を避けるため。
 */
export function buildVisibleCalendarRows(accountId: string, calendarIds: string[], now: number): VisibleCalendarRow[] {
  const uniqueCalendarIds = Array.from(new Set(calendarIds))
  return uniqueCalendarIds.map((calendarId) => ({ account_id: accountId, calendar_id: calendarId, created_at: now }))
}

/** PUT /api/visible-calendars: account_calendar_prefs へ upsert する行 (常に configured=1 を立てる)。 */
export function buildCalendarPrefsRow(accountId: string, now: number): CalendarPrefsRow {
  return { account_id: accountId, configured: 1, updated_at: now }
}
