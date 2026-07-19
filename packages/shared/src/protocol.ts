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
  /** 場所 (会議室、住所、URL など Google の location フィールドそのまま) */
  location?: string
  /** 説明 (HTML を含み得る。表示側でプレーンテキスト化する) */
  description?: string
}

/** 連携済みの Google アカウント1件。id は Google の sub */
export interface AccountDTO {
  id: string
  email: string
}

/**
 * マルチアカウント対応 (2026-07-19): セッション = プロファイルで、
 * プロファイルに複数の Google アカウントがぶら下がる。
 * connected は accounts.length > 0 と同義（後方互換のため残す）
 */
export interface MeResponse {
  connected: boolean
  accounts: AccountDTO[]
}

export interface CalendarListEntryDTO {
  id: string
  summary: string
  primary?: boolean
  /** Google カレンダーの色 (#rrggbb)。表示色のデフォルトに使う */
  backgroundColor?: string
}

/** GET /api/calendars?accountId=... で対象アカウントを指定する */
export interface SyncRequest {
  accountId: string
  calendarId: string
}

/** DELETE /api/account の body。accountId 指定でそのアカウントのみ解除、省略で全解除 */
export interface DisconnectRequest {
  accountId?: string
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

/**
 * POST /api/watch — 選択中カレンダーの push 通知 (watch channel) 登録/解除。
 * クライアントのカレンダー選択に追従して呼ぶ。登録は best-effort
 * (ローカル開発など webhook 不達環境では失敗してもアラームポーリングが補う)
 */
export interface WatchRequest {
  accountId: string
  calendarId: string
  enabled: boolean
}

/**
 * GET /api/events (SSE) が流すイベント。data は JSON。
 * 'changed' はトリガーに過ぎない — クライアントは該当 (accountId, calendarId) を
 * /api/sync で取りに行く (通知のペイロードを信用しない原則)。
 * SSE の id フィールドは単調増加し、再接続時は Last-Event-ID から欠落分を再送する。
 */
export type ServerEvent =
  | { type: 'hello' }
  | { type: 'changed'; accountId: string; calendarId: string }
