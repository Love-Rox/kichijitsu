/**
 * Sync Worker (apps/sync) と Web クライアント (apps/web) の API コントラクト。
 * サーバーはイベント本体を保存しない — Google から取った差分をこの DTO で
 * そのまま返し、正規化・展開はクライアント側で行う (正本はリモート、
 * ローカルはレプリカ、サーバーはトークンと sync 状態のみ)。
 */

/** Google Calendar API の event リソースから必要な部分だけを写した DTO */
export interface GoogleEventDTO {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  /** dateTime は RFC3339、date は終日予定 (YYYY-MM-DD) */
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  /** "RRULE:..." / "EXDATE;..." 等の行の配列 (繰り返し予定の親のみ) */
  recurrence?: string[];
  /** 例外インスタンスの場合のみ: 親シリーズの event id */
  recurringEventId?: string;
  originalStartTime?: { dateTime?: string; date?: string; timeZone?: string };
  updated?: string;
  colorId?: string;
  htmlLink?: string;
  /** 招待・共有をまたいで同一予定を示す不変 ID (重複表示の集約キー) */
  iCalUID?: string;
  /** 場所 (会議室、住所、URL など Google の location フィールドそのまま) */
  location?: string;
  /** 説明 (HTML を含み得る。表示側でプレーンテキスト化する) */
  description?: string;
  /**
   * カレンダーブロック機能 (docs/blocking.md) が mirror 識別 (kichijitsuMirror) を
   * 読むために必要。private は自分専用、shared は招待先とも共有される拡張プロパティ
   */
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
}

/** 連携済みの Google アカウント1件。id は Google の sub */
export interface AccountDTO {
  id: string;
  email: string;
}

/**
 * マルチアカウント対応 (2026-07-19): セッション = プロファイルで、
 * プロファイルに複数の Google アカウントがぶら下がる。
 * connected は accounts.length > 0 と同義（後方互換のため残す）
 */
export interface MeResponse {
  connected: boolean;
  accounts: AccountDTO[];
  /**
   * カレンダー選択のサーバー保存値 (2026-07-20): accountId → 表示中カレンダー id 配列。
   * 端末間で選択を揃えるため。エントリが無いアカウントは「未設定」でクライアントが
   * primary をデフォルト選択する。空配列は「全部外した」意思として尊重する。
   */
  visibleCalendars: Record<string, string[]>;
}

/**
 * PUT /api/visible-calendars — カレンダー選択をサーバーに保存 (端末間同期)。
 * 対象アカウントの所属検証あり。1アカウントぶんを上書き保存する。
 */
export interface VisibleCalendarsRequest {
  accountId: string;
  calendarIds: string[];
}

export interface CalendarListEntryDTO {
  id: string;
  summary: string;
  primary?: boolean;
  /** Google カレンダーの色 (#rrggbb)。表示色のデフォルトに使う */
  backgroundColor?: string;
}

/** GET /api/calendars?accountId=... で対象アカウントを指定する */
export interface SyncRequest {
  accountId: string;
  calendarId: string;
}

/** DELETE /api/account の body。accountId 指定でそのアカウントのみ解除、省略で全解除 */
export interface DisconnectRequest {
  accountId?: string;
}

export interface SyncResponse {
  /**
   * true = 全同期 (初回、または syncToken 失効 410 からのフォールバック)。
   * クライアントは既存の source==='google' データを破棄してから適用すること
   */
  isFullSync: boolean;
  events: GoogleEventDTO[];
}

export interface ApiError {
  error: string;
}

/**
 * POST /api/watch — 選択中カレンダーの push 通知 (watch channel) 登録/解除。
 * クライアントのカレンダー選択に追従して呼ぶ。登録は best-effort
 * (ローカル開発など webhook 不達環境では失敗してもアラームポーリングが補う)
 */
export interface WatchRequest {
  accountId: string;
  calendarId: string;
  enabled: boolean;
}

/**
 * GET /api/events (SSE) が流すイベント。data は JSON。
 * 'changed' はトリガーに過ぎない — クライアントは該当 (accountId, calendarId) を
 * /api/sync で取りに行く (通知のペイロードを信用しない原則)。
 * SSE の id フィールドは単調増加し、再接続時は Last-Event-ID から欠落分を再送する。
 */
export type ServerEvent =
  | { type: "hello" }
  | { type: "changed"; accountId: string; calendarId: string };

/**
 * POST /api/event/patch — 予定の時刻変更を Google へ書き戻す (フェーズ5)。
 * eventId は Google の生 event id。繰り返しシリーズの1回分 (この予定のみ) は
 * インスタンス ID (`<parentId>_<originalStart の UTC basic 形式 YYYYMMDDTHHMMSSZ>`)
 * をクライアント側で組み立てて渡す。
 * サーバーは events.patch に start/end (dateTime + timeZone) を渡すだけで、
 * 結果の正本は次の同期 (SSE changed → /api/sync) で還流する。
 */
export interface EventPatchRequest {
  accountId: string;
  calendarId: string;
  eventId: string;
  startMs: number;
  endMs: number;
  /** クライアントの IANA タイムゾーン (Google へ dateTime と共に渡す) */
  timeZone: string;
}

export interface EventPatchResponse {
  ok: boolean;
}

/**
 * POST /api/event/create — 新規予定を Google に作成 (フェーズ5)。
 * 作成結果の正本は次の同期 (SSE changed → /api/sync) で還流するが、UI の
 * 楽観的表示のため作成された eventId を即時に返す。終日予定は未対応 (時刻予定のみ)。
 */
export interface EventCreateRequest {
  accountId: string;
  calendarId: string;
  title: string;
  startMs: number;
  endMs: number;
  timeZone: string;
}

export interface EventCreateResponse {
  ok: boolean;
  /** Google が採番した event id (楽観的 occurrence を確定 id に差し替えるのに使う) */
  eventId: string;
}

/**
 * POST /api/event/delete — 予定を Google から削除 (フェーズ5)。
 * 繰り返しの1回分は EventPatchRequest と同じインスタンス ID の組み立て規則に従う。
 */
export interface EventDeleteRequest {
  accountId: string;
  calendarId: string;
  eventId: string;
}

export interface EventDeleteResponse {
  ok: boolean;
}

/**
 * Google タスク連携 (docs/google-tasks.md、2026-07-20)。タスクは due が日付精度のみ
 * (時刻は Google API が捨てる) なので日付レーンに表示する。追加スコープ tasks が必要。
 */
export interface TaskListDTO {
  id: string;
  title: string;
}

/** Google Tasks の task リソースから必要部分を写した DTO */
export interface GoogleTaskDTO {
  id: string;
  title: string;
  status: "needsAction" | "completed";
  /** RFC3339 だが日付精度のみ有効 (例 "2026-07-20T00:00:00.000Z")。無ければ due 無し */
  due?: string;
  notes?: string;
  updated?: string;
  /** 親タスク (サブタスク) の id */
  parent?: string;
}

/** GET /api/tasklists?accountId=... — アカウントのタスクリスト一覧 */
export interface TaskListsResponse {
  taskLists: TaskListDTO[];
}

/** POST /api/tasks/sync — 指定タスクリストの全タスクを取得 (updatedMin ポーリングの初回は全件) */
export interface TasksSyncRequest {
  accountId: string;
  taskListId: string;
}
export interface TasksSyncResponse {
  tasks: GoogleTaskDTO[];
}

/** POST /api/task/patch — タスクの完了状態変更 (完了=枡チェック)。将来 due 変更等も */
export interface TaskPatchRequest {
  accountId: string;
  taskListId: string;
  taskId: string;
  status: "needsAction" | "completed";
}
export interface TaskPatchResponse {
  ok: boolean;
}

/**
 * カレンダーブロック (docs/blocking.md、2026-07-20)。source カレンダー群の予定を
 * target カレンダーに Busy/不在として自動複製する。時間帯のみ複製し内容は写さない。
 */
export type BlockMode = "busy" | "outOfOffice";

export interface BlockRuleDTO {
  id: string;
  /** 複製元の (accountId, calendarId) 群 */
  sources: { accountId: string; calendarId: string }[];
  /** 複製先。1つ。outOfOffice は Workspace primary 限定 (非対応時は busy にフォールバック) */
  target: { accountId: string; calendarId: string };
  mode: BlockMode;
  /** true = 不在を要求したが Workspace 非対応で busy として作成された (UI 注記用) */
  oooFallback: boolean;
}

export interface BlockRulesResponse {
  rules: BlockRuleDTO[];
}

/** POST /api/block-rules — ルール作成/更新 (id 無しで新規、有りで更新) */
export interface BlockRuleUpsertRequest {
  id?: string;
  sources: { accountId: string; calendarId: string }[];
  target: { accountId: string; calendarId: string };
  mode: BlockMode;
}

/** DELETE /api/block-rules body */
export interface BlockRuleDeleteRequest {
  id: string;
}
