/**
 * Sync Worker (apps/sync) と Web クライアント (apps/web) の API コントラクト。
 * サーバーはイベント本体を保存しない — Google から取った差分をこの DTO で
 * そのまま返し、正規化・展開はクライアント側で行う (正本はリモート、
 * ローカルはレプリカ、サーバーはトークンと sync 状態のみ)。
 */

/** Google Calendar API の event リソースから必要な部分だけを写した DTO */
export interface GoogleEventDTO {
  id: string
  status: 'confirmed' | 'tentative' | 'cancelled'
  summary?: string
  /** dateTime は RFC3339、date は終日予定 (YYYY-MM-DD) */
  start?: { dateTime?: string; date?: string; timeZone?: string }
  end?: { dateTime?: string; date?: string; timeZone?: string }
  /** "RRULE:..." / "EXDATE;..." 等の行の配列 (繰り返し予定の親のみ) */
  recurrence?: string[]
  /** 例外インスタンスの場合のみ: 親シリーズの event id */
  recurringEventId?: string
  originalStartTime?: { dateTime?: string; date?: string; timeZone?: string }
  updated?: string
  colorId?: string
  htmlLink?: string
}

export interface MeResponse {
  connected: boolean
  email?: string
}

export interface CalendarListEntryDTO {
  id: string
  summary: string
  primary?: boolean
}

export interface SyncRequest {
  calendarId: string
}

export interface SyncResponse {
  /**
   * true = 全同期 (初回、または syncToken 失効 410 からのフォールバック)。
   * クライアントは既存の source==='google' データを破棄してから適用すること
   */
  isFullSync: boolean
  events: GoogleEventDTO[]
}

export interface ApiError {
  error: string
}
