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
   * Google の特殊イベント種別。events.list は常にこのフィールドを返す
   * (無指定の通常予定は "default")。不在レール表示 (2026-07-22、docs 未整備・
   * ユーザー要件のみ) が eventType==='outOfOffice' を「通常の予定カードとして
   * 描画しない」判定に使う。focusTime/workingLocation/birthday は現状表示側で
   * 特別扱いしないが、Google 側の型を欠落なく写すためここに含めておく。
   */
  eventType?: "default" | "outOfOffice" | "focusTime" | "workingLocation" | "birthday";
  /**
   * カレンダーブロック機能 (docs/blocking.md) が mirror 識別 (kichijitsuMirror) を
   * 読むために必要。private は自分専用、shared は招待先とも共有される拡張プロパティ
   */
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
  /**
   * 参加ステータス表示 (RSVP、2026-07-22)。event.attendees[] のうち self:true のエントリの
   * responseStatus。attendees が無い予定 (自分だけの予定・招待者がいない予定など) は
   * undefined ―― apps/web の EventBlock はこの場合を「従来どおりの通常表示」として扱う
   * (ユーザー決定: attendees の無い自分の予定は表示を変えない)。attendees 配列自体は
   * DTO に載せない(サーバーはイベント本体を保存しない設計のため、必要な派生値だけを
   * 最小限持たせるリーン維持の方針。isOutOfOffice/isMirror と同じ考え方)。
   */
  selfResponseStatus?: "accepted" | "declined" | "tentative" | "needsAction";
  /**
   * 参加ステータス表示 (RSVP、2026-07-22)。event.organizer.self===true かどうか。
   * 「不参加 (declined) の非表示」フィルタのサブオプション「自分が主催の予定は残す」の
   * 判定に使う (apps/web の shouldHideDeclined)。true のときのみセットする
   * (false/undefined は「主催ではない」相当、isMirror と同じ bool の乗せ方)。
   */
  isOrganizer?: boolean;
  /**
   * 参加ステータス表示 (RSVP、2026-07-22)。会議リンク (event.conferenceData または
   * event.hangoutLink) の有無。Google Calendar API は「自分がオンライン/現地のどちらで
   * 参加するか」という attendee 単位の手段を公開していないため、イベント側に会議リンクが
   * 存在するかどうかで近似する(ユーザー決定 2026-07-22、詳細は apps/sync の
   * deriveHasConference 参照)。true のときのみセットする(実際の URL 等の中身は含めない
   * ―― リーン維持)。
   */
  hasConference?: boolean;
}

/** 連携済みの Google アカウント1件。id は Google の sub */
export interface AccountDTO {
  id: string;
  email: string;
}

/**
 * 連携済みの GitHub アカウント (docs/github-oauth.md、2026-07-20)。プロファイル1つにつき
 * 高々1件。
 */
export interface GitHubConnectionDTO {
  login: string;
}

/**
 * GET /api/github/items が返す1件の種別 (docs/github-integration.md フェーズ①)。
 * milestone 自体も1アイテムとして含み、issue/PR はその所属 milestone にぶら下がる。
 */
export type GitHubItemType = "milestone" | "issue" | "pr" | "release";

/**
 * milestone 期日 + その milestone に属する open issue/PR + 公開済み release の1件
 * (docs/github-integration.md フェーズ①、release は同フェーズ④「first cut」、2026-07-20)。
 * サーバーは GitHub アイテム本体を永続化しない — 取得の都度 DTO に変換してそのまま返す
 * (Google の GoogleEventDTO と同じ思想)。
 * Projects v2 (GraphQL) の date フィールドは対象外 (次フェーズ)。
 */
export interface GitHubItemDTO {
  /** 安定 ID: `gh:{owner}/{repo}:milestone:{n}` / `gh:{owner}/{repo}:{issue|pr}:{n}` /
   * `gh:{owner}/{repo}:release:{tagName}` */
  id: string;
  type: GitHubItemType;
  title: string;
  /** 期日 (milestone の due_on を epoch ms 化)。issue/PR は所属 milestone の due_on を継承する
   * (GitHub の issue/PR 自体には締切概念が無いため)。release は published_at を epoch ms 化。 */
  dateMs: number;
  /** "owner/repo" */
  repo: string;
  /** release には GitHub の issue 的な番号が無いため常に 0 (一意性は id のタグ由来部分が担う)。 */
  number: number;
  /** html_url */
  url: string;
  /** issue/PR が属する milestone のタイトル。milestone/release 自身のアイテムには付かない。 */
  milestoneTitle?: string;
}

/** GET /api/github/items のレスポンス。 */
export interface GitHubItemsResponse {
  items: GitHubItemDTO[];
}

/**
 * GET /api/github/queue が返す1件の分類 (docs/github-integration.md フェーズ②「作業キュー」、
 * 2026-07-20)。GitHub Search API の3クエリ (review-requested:@me / assignee:@me /
 * author:@me) に対応する。
 */
export type GitHubWorkKind = "review_requested" | "assigned" | "authored";

/**
 * 作業キューの1件 (docs/github-integration.md フェーズ②)。同一 (repo, number) が複数クエリに
 * ヒットすること (自分が author かつ assignee 等) があるため dedupe せず、該当する分類を
 * `kinds` に配列でまとめる — UI 側は1アイテムとして素直に扱える。
 */
export interface GitHubWorkItemDTO {
  /** 安定 ID: `ghq:{owner}/{repo}:{issue|pr}:{number}` */
  id: string;
  type: "issue" | "pr";
  /** このアイテムが該当する分類 (複数可、重複なし)。 */
  kinds: GitHubWorkKind[];
  title: string;
  /** "owner/repo" */
  repo: string;
  number: number;
  /** html_url */
  url: string;
  /** ISO 8601 (並び替え用)。 */
  updatedAt: string;
}

/** GET /api/github/queue のレスポンス。 */
export interface GitHubQueueResponse {
  items: GitHubWorkItemDTO[];
}

/**
 * GET /api/github/activity が返す1件の種別 (docs/github-integration.md フェーズ③
 * 「実績オーバーレイ」Part A、2026-07-20)。第1弾は commit のみ — PR/レビュー活動は
 * 将来この union にバリアントを足すだけで拡張できる形にしてある。
 */
export type GitHubActivityType = "commit"; // 将来 'pr' | 'review' を足す

/**
 * 実績オーバーレイの1件 (docs/github-integration.md フェーズ③)。インストール先 repo に
 * 対して `author=自分の login` + 表示中の時間範囲 (since/until) で commits API を叩いた
 * 結果を DTO 化したもの。サーバーは永続化しない (GitHubItemDTO 等と同じ思想)。
 */
export interface GitHubActivityDTO {
  /** 安定 ID: `gha:{owner}/{repo}:commit:{sha}` */
  id: string;
  type: GitHubActivityType;
  /** commit メッセージの先頭行のみ。 */
  title: string;
  /** "owner/repo" */
  repo: string;
  /** html_url */
  url: string;
  /** 活動時刻 (epoch ms)。グリッドに時刻配置するのに使う。 */
  timestampMs: number;
}

/** GET /api/github/activity のレスポンス。 */
export interface GitHubActivityResponse {
  items: GitHubActivityDTO[];
}

/**
 * GET /api/github/ci が返す workflow run の status (docs/github-integration.md フェーズ④b
 * 「CI/Actions 実行をタイムラインに薄く重ねる」、2026-07-20)。GitHub Actions API の生文字列。
 */
export type GitHubCiStatus = "queued" | "in_progress" | "completed";

/**
 * workflow run の conclusion。status==='completed' のときのみ意味を持つ (それ以外は null)。
 * GitHub Actions API の生文字列。
 */
export type GitHubCiConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "neutral"
  | "timed_out"
  | "action_required"
  | "startup_failure"
  | null;

/**
 * CI/Actions 実行オーバーレイの1件 (docs/github-integration.md フェーズ④b、2026-07-20)。
 * インストール先 repo に対して workflow run を `created` (表示中の時間範囲) で絞って取得した
 * 結果を DTO 化したもの。フェーズ③の実績オーバーレイ (commit) と違い、自分がトリガーした分に
 * 限定しない (誰の push の CI 実行でも見える。将来 actor 絞りは拡張)。サーバーは永続化しない
 * (GitHubActivityDTO 等と同じ思想)。status/conclusion は GitHub の生文字列をそのまま string で
 * 持てば表示には十分なため、GitHubCiStatus/GitHubCiConclusion という厳密 union はここでは使わない
 * (クライアント側で必要になったときの参照用にエクスポートのみしておく)。
 */
export interface GitHubCiRunDTO {
  /** 安定 ID: `gci:{owner}/{repo}:{runId}` */
  id: string;
  /** "owner/repo" */
  repo: string;
  /** workflow 名。 */
  name: string;
  /** html_url */
  url: string;
  /** GitHub の生文字列そのまま (queued/in_progress/completed)。 */
  status: string;
  /** GitHub の生文字列そのまま (success/failure/...) または未完了なら null。 */
  conclusion: string | null;
  /** created_at を epoch ms 化。グリッドに時刻配置するのに使う。 */
  timestampMs: number;
}

/** GET /api/github/ci のレスポンス。 */
export interface GitHubCiRunsResponse {
  items: GitHubCiRunDTO[];
}

/**
 * POST /api/github/pr-commits のリクエスト (docs/github-integration.md フェーズ③「時間計測」
 * Part A)。予定ブロックに紐づく PR (type: 'pr' に絞るのは呼び出し側の責務) について、
 * 自分の commit 時刻を取得する。
 */
export interface PullCommitsRequest {
  items: { repo: string; number: number }[];
}

/** POST /api/github/pr-commits のレスポンス。キー "{owner/repo}#{number}" → 昇順 ISO タイムスタンプ配列。 */
export interface PullCommitsResponse {
  commitsByItem: Record<string, string[]>;
}

/**
 * リポジトリ参照の最小形 (実績 UX 刷新フェーズ3「手動追加フォームのプルダウン化」、2026-07-23)。
 * GET /api/github/repos が返す1件、および web 側 githubProvider の repo discovery が返す形。
 * サーバー版は GitHub App インストール先 (listInstallationRepos)、gh 版は `user/repos` 由来で、
 * どちらも "owner/repo" を owner と repo に分けて持つ (WorkLogModal の org/repo カスケード
 * プルダウンの元データ)。
 */
export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

/** GET /api/github/repos のレスポンス。 */
export interface GitHubReposResponse {
  repos: GitHubRepoRef[];
}

/**
 * 1 リポジトリの open な issue / PR の最小形 (実績 UX 刷新フェーズ3、2026-07-23)。GitHub の
 * `GET /repos/{owner}/{repo}/issues?state=open` は issue と PR の両方を返し、要素に
 * `pull_request` フィールドがあるものが PR — その有無で type を分ける (GitHubItemDTO 等と同じ判定)。
 * WorkLogModal の issue/PR プルダウンの選択肢に使う (number を issueRef に入れる)。
 */
export interface GitHubRepoIssue {
  number: number;
  title: string;
  type: "issue" | "pr";
}

/** GET /api/github/repo-issues のレスポンス。 */
export interface GitHubRepoIssuesResponse {
  issues: GitHubRepoIssue[];
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
  /** GitHub 連携が無ければ null。 */
  github: GitHubConnectionDTO | null;
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
  /**
   * このカレンダーに対するユーザーのアクセス権限 (Google Calendar API の
   * CalendarListEntry.accessRole をそのまま透過)。左ペイン(CalendarPane、
   * カレンダーナビゲーション増分1、2026-07-22)が「マイカレンダー」(owner) と
   * 「他のカレンダー」(writer/reader/freeBusyReader、祝日・購読・同僚のカレンダー等)を
   * 分類するのに使う。旧クライアント/取得失敗時の後方互換のため optional にしてある
   * (undefined は「他のカレンダー」側に倒す — apps/web/src/sync/calendarGroups.ts 参照)。
   */
  accessRole?: "owner" | "writer" | "reader" | "freeBusyReader";
}

/** GET /api/calendars?accountId=... で対象アカウントを指定する */
export interface SyncRequest {
  accountId: string;
  calendarId: string;
  /**
   * 端末ごとの同期トークンのキー (2026-07-21、端末ごと syncToken)。クライアント側で
   * 永続生成する UUID (ブラウザプロファイル/Tauri webview ごとに1つ)。
   * 未指定はレガシー共有トークン (全端末で1本、移行期のみ) を使う後方互換パス —
   * 旧クライアントの in-flight リクエストが 400 にならないよう optional にしてある。
   */
  deviceId?: string;
  /**
   * true ならサーバー保存の syncToken (レガシー共有 / sync_tokens_v2 いずれも) を無視して
   * 全同期を強制する (2026-07-22、eventType バックフィル用)。既存の同期済みイベントは
   * 変更が無い限り増分同期で再配信されないため、mapGoogle.ts の isOutOfOffice のように
   * 「サーバーは保存しないが DTO 上の新フィールドから初めて導出するフラグ」を後から
   * 追加したとき、デプロイ前に取得済みのイベントには永久にフラグが付かない — これを
   * 解消するにはクライアント側がローカルレプリカ全体を一度作り直す (= 全同期) 必要がある。
   * saveSyncToken 自体は通常どおり動く (core/sync.ts) ため、この同期が完了すれば
   * 次回からは通常の増分同期に戻る (一回きりの強制であり、恒久設定ではない)。
   */
  forceFull?: boolean;
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
 * POST /api/event/patch — 予定の変更を Google へ書き戻す (フェーズ5、2026-07-22 全項目編集に拡張)。
 * eventId は Google の生 event id。繰り返しシリーズの1回分 (この予定のみ) は
 * インスタンス ID (`<parentId>_<originalStart の UTC basic 形式 YYYYMMDDTHHMMSSZ>`)
 * をクライアント側で組み立てて渡す。
 *
 * サーバーは Google の `events.patch` (PATCH は指定した top-level フィールドのみを
 * マージ更新し、未指定のフィールドは既存値を保持する) にそのまま渡す薄いプロキシであり、
 * 結果の正本は返さない — 次の同期 (SSE changed → /api/sync) で還流する。
 *
 * startMs/endMs/timeZone は元々のフェーズ5 (時刻のみ書き換え) からの必須フィールドで、
 * 後方互換のためそのまま残す。summary/location/description/isAllDay は編集フォームの
 * 保存時に全項目を送る想定の optional 拡張 — 未指定のキーは PATCH body に含めない
 * (google/patch-event.ts が JSON.stringify の undefined 省略を利用してそのまま Google に渡す)
 * ので、Google 側で既存値が保持される。空文字は「クリア」の意図として明示的に送る
 * (例: location: "" で場所を消せる)。
 */
export interface EventPatchRequest {
  accountId: string;
  calendarId: string;
  eventId: string;
  startMs: number;
  endMs: number;
  /** クライアントの IANA タイムゾーン (Google へ dateTime と共に渡す。isAllDay の date 変換にも使う) */
  timeZone: string;
  /** 指定時のみ更新 (未指定は既存値を保持)。空文字は「クリア」。 */
  summary?: string;
  /** 指定時のみ更新。空文字は「クリア」。 */
  location?: string;
  /** 指定時のみ更新。空文字は「クリア」。 */
  description?: string;
  /**
   * true なら終日予定として start/end を Google の `date` (YYYY-MM-DD) 形式で送る
   * (startMs/endMs を timeZone で日付に変換する、google/patch-event.ts の toDateOnly 参照)。
   * false/未指定は従来どおり `dateTime` (時刻予定)。
   */
  isAllDay?: boolean;
}

export interface EventPatchResponse {
  ok: boolean;
}

/**
 * RSVP (自分の参加ステータス変更、2026-07-22) が取り得る値。Google の
 * attendee.responseStatus の生文字列のうち kichijitsu が扱う4値
 * (GoogleEventDTO.selfResponseStatus と同じ union)。
 */
export type RsvpResponseStatus = "accepted" | "declined" | "tentative" | "needsAction";

/**
 * POST /api/event/rsvp — 自分の参加ステータスを Google へ書き戻す (2026-07-22)。
 * Google Calendar API に RSVP 専用エンドポイントは無く、`events.patch` で attendees
 * 配列全体を送る必要がある (attendees はマージでなく全置換) ため、サーバー側で
 * `events.get` → self attendee の responseStatus 差し替え → `events.patch` の
 * read-modify-write を行う (core/rsvp-event.ts 参照)。sendUpdates=all を付けるので
 * 主催者に通知が飛ぶ (RSVP としては自然な挙動)。
 * self (attendee.self===true) が見つからない予定 (自分だけの予定・招待されていない予定)
 * は 422 not_an_attendee を返す。
 */
export interface EventRsvpRequest {
  accountId: string;
  calendarId: string;
  eventId: string;
  responseStatus: RsvpResponseStatus;
}

export interface EventRsvpResponse {
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

/**
 * kichijitsu 発行の MCP トークン (docs/mcp.md、2026-07-20)。Part A (このフェーズ) は
 * トークンのライフサイクル管理 (発行/一覧/失効) のみ — `/mcp` エンドポイント自体は Part B。
 * サーバーは生トークンをハッシュのみで保存するため、DTO にも生値は含まれない
 * (生値が乗るのは McpTokenCreateResponse の `token` フィールドのみ、発行直後の一度きり)。
 */
export interface McpTokenDTO {
  id: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}
export interface McpTokensResponse {
  tokens: McpTokenDTO[];
}
export interface McpTokenCreateRequest {
  label?: string;
}
export interface McpTokenCreateResponse {
  token: string; // raw value — returned only this once, never again
  id: string;
  label: string | null;
  createdAt: number;
}
export interface McpTokenDeleteRequest {
  id: string;
}

/**
 * POST /api/work-intervals (docs/mcp.md「エージェントの作業時間記録」) — hook から作業実績を
 * 記録する REST 経路。認証は MCP トークンの Bearer (セッション cookie ではない、非対話利用のため)。
 * MCP ツール log_work_interval と同じ core (core/work-log.ts) を呼ぶ。
 *
 * D1 保存 (2026-07-21移行): 当初は Google カレンダーへの書き込みだったが、カレンダー新規作成に
 * calendar.events スコープでは足りず 403 になる実バグが本番で判明したため work_logs テーブルへの
 * D1 保存に切り替えた。timeZone は D1 保存では不要になったが、既存 hook との後方互換のため
 * フィールド自体は受け付ける (サーバー側では無視する)。
 */
export interface WorkIntervalRequest {
  start: string;
  end: string;
  repo: string;
  branch?: string;
  issueRef?: string;
  agent?: string;
  timeZone?: string;
}
export interface WorkIntervalResponse {
  id: string;
}

/**
 * GET /api/work-logs (docs/mcp.md「エージェントの作業時間記録」) — web 用。認証はセッション
 * cookie (POST /api/work-intervals の Bearer とは経路が異なる)。TimeReportOverlay の「hook 実績」
 * 列が sync/hookActual.ts の突合に使う。
 */
export interface WorkLogDTO {
  id: string;
  repo: string;
  issueRef?: string;
  branch?: string;
  agent?: string;
  startMs: number;
  endMs: number;
}
export interface WorkLogsResponse {
  workLogs: WorkLogDTO[];
}

/**
 * POST /api/work-logs (cookie 認証、手動入力用) — TimeReportOverlay の「実績を手動で追加」フォームが
 * 呼ぶ、work-log の書き込み経路その2 (hook 用の POST /api/work-intervals は Bearer 認証で別経路の
 * まま変更していない)。body は WorkIntervalRequest と同じ ISO 文字列の start/end
 * (web 側は datetime-local の値を apps/web/src/sync/workLogEntry.ts で ISO に変換してから送る —
 * サーバー側の検証・保存 (core/work-log.ts の validateWorkLogInput/buildWorkLogRow) を hook 経路と
 * そのまま共有するため)。agent を省略するとサーバー側 (resolveManualWorkLogAgent) が "manual" を
 * 補い、これが hook 記録 (agent: "claude-code" 等) と手動記録を見分ける目印になる。
 */
export interface WorkLogCreateRequest {
  start: string;
  end: string;
  repo: string;
  issueRef?: string;
  branch?: string;
  agent?: string;
  timeZone?: string;
}
export interface WorkLogCreateResponse {
  id: string;
}

/**
 * PATCH /api/work-logs/:id (cookie 認証、手動記録の後追い訂正用、2026-07-23) — 既存の work_log を
 * 部分更新する。過去に手入力/hook で記録した実績を後から直せるようにするための経路。
 * 全フィールド任意 = 与えられたキーだけを更新する (未指定のキーは現状維持)。start/end は
 * WorkLogCreateRequest と同じ ISO 文字列 (web 側が datetime-local → ISO に変換して送る)。
 * サーバー側の検証・列組み立ては core/work-log.ts (validateWorkLogInput 相当の部分検証 +
 * updateWorkLog/buildWorkLogUpdate) が担う。所有チェックは DELETE と同じく他プロファイル/存在
 * しない id を区別せず 403 (work_log_not_found) にする。
 */
export interface WorkLogUpdateRequest {
  start?: string;
  end?: string;
  repo?: string;
  issueRef?: string;
  branch?: string;
  agent?: string;
}

/**
 * 作業ログの「開区間 (実行中)」経路 (docs/mcp.md「エージェントの作業時間記録」)。開始と停止を
 * 別々に記録する。開始 = work_logs に end_ms IS NULL の行を1本立てる、停止 = その行に end_ms を
 * 書き込む。従来の POST /api/work-intervals (完了区間を start/end 同時に記録) はそのまま残る。
 *
 * 一意性: (profile_id, repo, issueRef) ごとに開始中は1本まで (issueRef 省略/空は空文字扱い)。
 * 既に開始中があるのに再度 start されたら no-op で既存を返す (alreadyOpen: true)。
 * 孤立停止 (対応する開始が無い stop) は何も作らず closed: false / reason: "no_open_interval"。
 *
 * start/end は ISO 文字列 (省略時はサーバーの現在時刻)。timeZone は D1 保存では不要だが、
 * 既存 hook の他経路 (WorkIntervalRequest) と揃えて後方互換のため受け付ける (サーバーは無視する)。
 */
export interface WorkIntervalStartRequest {
  repo: string;
  issueRef?: string;
  branch?: string;
  agent?: string;
  start?: string;
  timeZone?: string;
}
export interface WorkIntervalStartResponse {
  id: string;
  /** true = 同一 (repo, issueRef) の開始中が既にあり、新規作成せず既存を返した (no-op)。 */
  alreadyOpen: boolean;
}
export interface WorkIntervalStopRequest {
  repo: string;
  issueRef?: string;
  end?: string;
  timeZone?: string;
}
export interface WorkIntervalStopResponse {
  /** true = 開始中を停止して確定した。false = 対応する開始中が無かった (孤立停止)。 */
  closed: boolean;
  /** closed: true のとき停止した行の id。 */
  id?: string;
  /** closed: false のとき理由 ("no_open_interval")。 */
  reason?: string;
}

/**
 * GET /api/work-logs/open (cookie 認証、web 用) — 実行中 (end_ms IS NULL) の開区間一覧。
 * 確定済み (end_ms 非 NULL) の WorkLogDTO とは別 DTO・別エンドポイントで扱い、GET /api/work-logs
 * (WorkLogDTO) には開始中が混ざらないようにする (endMs: number のまま無変更に保つため)。
 */
export interface OpenWorkIntervalDTO {
  id: string;
  repo: string;
  issueRef?: string;
  branch?: string;
  agent?: string;
  startMs: number;
}
export interface OpenWorkIntervalsResponse {
  open: OpenWorkIntervalDTO[];
}
