/**
 * Sync Worker (apps/sync) と Web クライアント (apps/web) の API コントラクト。
 * サーバーはイベント本体を保存しない — Google から取った差分をこの DTO で
 * そのまま返し、正規化・展開はクライアント側で行う (正本はリモート、
 * ローカルはレプリカ、サーバーはトークンと sync 状態のみ)。
 */

/**
 * 予定の参加者 (ゲスト) 1件 (参加者の表示、2026-07-30)。Google Calendar API の
 * `event.attendees[]` から、**画面に出すのに要る分だけ**を写した最小形。
 *
 * 落としているフィールド (意図的): `comment` / `additionalGuests` / `id` / `optional` /
 * `responseStatus` 以外の書き込み系。参加者は1予定に数十人入りうるうえ、その全部が
 * 端末の IndexedDB に載る (サーバーはイベント本体を保存しない設計なので、レプリカ側の
 * サイズがそのままコストになる) ため、「誰が・どう返事したか」を読むのに要らない値は
 * 最初から運ばない。書き戻し (RSVP) 側は attendees 配列を丸ごと read-modify-write する
 * (core/rsvp-event.ts) ので、この DTO が欠けても書き込みの正しさには影響しない。
 *
 * email/displayName の有無は Google の仕様どおり両方 optional として扱う ―― 表示名は
 * 連絡先に無い相手だと付かず、email も (resource など) 常にあるとは限らない。
 * 表示ラベルの決定はクライアント側の純関数 (web の layout/guestList.ts) が行う。
 */
export interface EventAttendeeDTO {
  /** attendee.email。同一性の判定と、表示名が無いときの表示に使う。 */
  email?: string;
  /** attendee.displayName。Google 側に登録が無ければ付いてこない。 */
  displayName?: string;
  /** attendee.responseStatus。Google が返す4値のうち union に合うものだけを通す。 */
  responseStatus?: RsvpResponseStatus;
  /** attendee.self === true のときだけ立てる (自分の行)。 */
  self?: true;
  /** attendee.organizer === true のときだけ立てる (主催者の行)。 */
  organizer?: true;
  /**
   * attendee.resource === true のときだけ立てる。**会議室や機材であって人ではない**ので、
   * 表示側は人数にも出欠の集計にも含めない (web の layout/guestList.ts 参照)。
   */
  resource?: true;
}

/**
 * 予定ごとのリマインダー設定 (2026-07-31)。Google Calendar API の `event.reminders` を
 * **デスクトップ通知に意味のある形だけ**に潰したもの。
 *
 * Google 側の形は `{ useDefault: boolean, overrides?: [{ method, minutes }] }` で、公式仕様
 * (developers.google.com/workspace/calendar/api/v3/reference/events) では:
 *   - `method` は `"email"` と `"popup"` の2値のみ (v3 リファレンスに他の値の記述は無い)
 *   - `minutes` は 0〜40320 (4週間)
 *   - `overrides` は最大5件
 *   - `useDefault: true` のときは overrides を持てない ("Overrides can be set if and only if
 *     useDefault is false." — /api/concepts/reminders)。このとき実際の分数は**このイベントには
 *     入っておらず**、カレンダー側の既定 (CalendarListEntryDTO.defaultReminderMinutes) から来る
 *
 * **`email` は載せない**: 公式の Delivery mechanisms が "Email sent by the server" と明記して
 * おり、メールは Google 自身が送る。kichijitsu が同じ時刻にデスクトップ通知を重ねると、
 * 「メールで受け取る」と決めた設定が勝手にポップアップに化けることになる。`popup` だけを写す。
 *
 * 判別可能ユニオンにしてあるのは、**3つの状態を取り違えないため**:
 *   - `{ useDefault: true }` … カレンダーの既定に従う (分数はこのイベントには無い)
 *   - `{ minutes: [] }`      … **リマインダーを1つも設定していない** (= 通知しない、が正解)
 *   - `undefined`            … このフィールドを同期する前 (世代6以前) に取り込んだ予定、または
 *                              Google 由来でない予定。「設定が無い」とは意味が違う
 */
export type EventRemindersDTO =
  /** event.reminders.useDefault === true。実際の分数はカレンダー既定側にある */
  | { useDefault: true }
  /**
   * event.reminders.overrides のうち method==='popup' のものの minutes (昇順・重複除去)。
   * **空配列は「リマインダーなし」という積極的な意味を持つ** ので、空でも省略しないこと。
   */
  | { minutes: number[] };

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
   * deriveHasConference 参照)。true のときのみセットする(「参加できる手段があるか」の
   * 判定はこのフラグ、実際に開く URL は下の conferenceUrl を使う)。
   */
  hasConference?: boolean;
  /**
   * 会議への参加 URL (2026-07-25)。event.conferenceData.entryPoints[].uri (entryPointType
   * ==='video' 優先) または event.hangoutLink から1つだけ選んだもの (詳細は apps/sync の
   * deriveConferenceUrl)。Google Meet とカレンダーのアドオン経由の Zoom/Teams は URL が
   * location ではなくここにしか入らないため、「○○で参加」リンクを出すために hasConference
   * とは別に値そのものを載せる (Slack ハドルは location に URL が入るのでクライアント側で
   * 判定できる)。
   *
   * hasConference が true でも取得できないことがある: entryPoints が電話参加 (tel:) のみの
   * 会議や、Google が稀に返す空の conferenceData ―― 「会議リンクあり」のアイコンは出るが
   * 参加リンクは出せないケースとして扱うこと。
   */
  conferenceUrl?: string;
  /**
   * 参加者 (ゲスト) の一覧 (2026-07-30)。attendees が無い予定 (自分だけの予定・招待者が
   * いない予定) はキー自体を持たない。
   *
   * selfResponseStatus/isOrganizer は同じ attendees から導いた**派生値**で、こちらは
   * 一覧そのもの。派生値を残してあるのは、attendees を捨てていた時代のクライアント
   * (と、この配列が打ち切られたケース) でも自分の RSVP だけは必ず読めるようにするため。
   *
   * **件数の上限あり**: apps/sync の MAX_DTO_ATTENDEES 件までしか載せない。超えた場合は
   * attendeesOmitted が true になる (下記)。
   */
  attendees?: EventAttendeeDTO[];
  /**
   * attendees が全員ぶんではないことを示す (2026-07-30)。Google 自身が返す同名フィールド
   * (maxAttendees を指定したときに立つ) と、kichijitsu 側の打ち切り (MAX_DTO_ATTENDEES) の
   * どちらでも true になる。表示側は人数を断定せず「〜人以上」と出すこと。
   */
  attendeesOmitted?: true;
  /**
   * 予定ごとのリマインダー設定 (2026-07-31)。EventRemindersDTO のコメント参照。
   *
   * デスクトップ版の通知 (apps/web/src/sync/reminderSchedule.ts) が「何分前に出すか」を
   * 決めるのに使う。これが載る前 (バックフィル世代6以前) の予定は undefined のままなので、
   * 世代を7へ上げて全端末に1回だけ forceFull 同期を走らせる。
   *
   * ⚠️ 公式に「changing reminders does not also change the `updated` property of the enclosing
   * event」と明記がある。リマインダーだけを変更した予定が差分同期でいつ届くかは Google の
   * 変更フィード次第で、`updated` を当てにはできない。
   */
  reminders?: EventRemindersDTO;
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
  /**
   * この sync (サーバー) が**対応している同期バックフィル世代** (2026-07-25)。
   *
   * クライアントは「新しい DTO フィールドを増やすたびに世代を1つ上げ、保存済み世代に追いつくまで
   * forceFull 同期する」仕組みを持つ (apps/web の CURRENT_SYNC_BACKFILL_VERSION / syncBackfill.ts)。
   * ところが web と sync は別々にデプロイされるため、web だけ先に新しくなると「サーバーがまだ
   * そのフィールドを返さないのに、クライアントはバックフィル完了として世代を記録してしまう」
   * → 以後 forceFull が走らず、そのフィールドが永久に欠けたままになる、という事故が起きる
   * (実際に世代3のバックフィルで発生し、世代4を空振り用に消費して手当てした)。
   *
   * その恒久対策として、sync 側が自分の対応世代をここで宣言する。クライアントは
   * min(自分の世代, この値) までしかバックフィル完了として記録しない — サーバーが後から
   * 追いついた時点で残りの世代分のバックフィルが自然に走る。
   *
   * 省略可能 (この仕組みより前の sync がデプロイされている間は載ってこない)。省略時は
   * クライアントが自分の世代をそのまま使う (従来どおりの挙動)。
   */
  syncBackfillVersion?: number;
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
  /**
   * このカレンダーの既定リマインダー (2026-07-31)。CalendarListEntry.defaultReminders のうち
   * method==='popup' のものの minutes (昇順・重複除去)。
   *
   * ここにしか無い値: 予定側が `reminders.useDefault: true` (= Google 上の大多数の予定) のとき、
   * 実際の分数はイベントに入っておらずカレンダー既定から来る。公式も「Default reminders are
   * manipulated through the CalendarList collection … They're not accessible through the
   * Calendars collection」と明記している (/api/concepts/reminders)。
   *
   * events.list の応答トップレベルにも同じ値が `defaultReminders` として載るが、そちらは
   * 採らない ―― カレンダー一覧は起動のたびに GET /api/calendars で取り直されるのに対し、
   * events.list の応答は syncToken 次第で「差分ゼロ」になり得るので、既定リマインダーを
   * 変更したときの追随はカレンダー一覧側のほうが素直。
   *
   * 空配列は「このカレンダーには既定リマインダーが無い」(祝日カレンダー等でよくある) の意味で、
   * undefined は「この項目を返す前のサーバー」。表示ではなく通知の判定にしか使わないので、
   * どちらも「通知しない」に落ちる点では同じ扱いでよい。
   */
  defaultReminderMinutes?: number[];
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
 * timeZone は元々のフェーズ5 (時刻のみ書き換え) からの必須フィールド。
 * summary/location/description/isAllDay は編集フォームの
 * 保存時に全項目を送る想定の optional 拡張 — 未指定のキーは PATCH body に含めない
 * (google/patch-event.ts が JSON.stringify の undefined 省略を利用してそのまま Google に渡す)
 * ので、Google 側で既存値が保持される。空文字は「クリア」の意図として明示的に送る
 * (例: location: "" で場所を消せる)。
 *
 * **繰り返し予定の適用範囲 (2026-07-30)**: 「すべての予定」を選んだときは、この eventId に
 * 親 (シリーズ) の event id が入る。適用範囲そのものはクライアント側で eventId と時刻に
 * 解決してから送るため、サーバーには渡らない (web/src/sync/recurrenceScope.ts 参照)。
 *
 * **ゲストへの通知 (2026-07-31)**: sendUpdates を参照。
 */
/**
 * 予定の**変更**を Google に書き戻すときの `sendUpdates` (2026-07-31)。
 * Google Calendar API の enum は `all` / `externalOnly` / `none` の3値だが、
 * kichijitsu が変更 (時刻・タイトル・場所・説明) で使うのは**上2つだけ**。
 *
 * ## 「招待」と「更新」で必要な値が違う
 * ゲストの追加・削除 (EventGuestsRequest) は `all` 固定にしてある ―― **招待が届かなければ
 * 相手のカレンダーに予定が現れない**相手がいるため (「差出人を知っている場合のみ追加」の
 * 設定など)。しかし**既にゲストが持っている予定の時刻やタイトルを変える**場合は、
 * 相手は既にその予定を持っており、事情が違う:
 *
 *  - `sendUpdates` が決めるのは「更新を知らせる**通知 (メール)** を誰に出すか」であって、
 *    予定そのものが届くかではない (公式のパラメータ説明も "Guests who should receive
 *    **notifications** about the event update (for example, title changes, etc.)")。
 *    主催者側の変更が参加者の複製へ伝わること自体は Event propagation に明記がある ――
 *    "When this information is updated on the organizer calendar, the changes are
 *    propagated to attendee copies."
 *  - 一方 **Google カレンダー以外を使うゲスト**はメールでしか更新を受け取れない。
 *    公式ヘルプが明言している ―― "You can also choose not to send email notifications.
 *    Guests' calendars are still updated, unless: ... Non-Google Calendar users and
 *    Google Calendar users with a non-Gmail email provider get an email, which updates
 *    their calendar per the settings of their calendar service."
 *    ここを止めると相手のカレンダーだけが**古い時刻のまま**残る ―― 送った側からは
 *    決して見えない壊れ方で、これが `none` を選択肢にしない理由。
 *
 * したがって「知らせなくてよい」の正しい表現は `none` ではなく `externalOnly`
 * ("Notifications are sent to non-Google Calendar guests only.") になる。
 * この使い分けは、そもそも `externalOnly` が足された理由そのものでもある ――
 * 2018-10-02 のリリースノート: "Now it is possible to always keep in sync guests who use
 * other calendaring systems, without sending too many non-mandatory emails to
 * Google Calendar users."
 *
 * kichijitsu の UI が出す2択もこの2値に対応する (web/src/sync/guestNotify.ts):
 *
 *  - `all`          … 「送信する」。ゲスト全員にメールが飛ぶ。
 *  - `externalOnly` … 「送信しない」。Google カレンダーのゲストにはメールを出さない
 *                     (予定は同期で直る)。外部のゲストには出る (それしか手段が無い)。
 *
 * ## 省略されたら (2026-07-31 に調べ直した結論: **分からない**)
 * 公式リファレンスは events.patch/update で **sendUpdates を省略したときの既定を
 * 文書化していない**。同じページの隣のパラメータ (conferenceDataVersion, supportsAttachments)
 * には "The default is ..." が書いてあるのに sendUpdates には無く、Discovery ドキュメントの
 * どの sendUpdates にも `default` フィールドが無い。廃止された `sendNotifications` には
 * "The default is false." と書いてあるが、**両方とも省略したときにどちらが効くのかは
 * どこにも書かれていない** (2018-10-02 の追加を告げるリリースノートにも既定の記述は無く、
 * 更新のガイドページ自体が存在しない)。events.insert のページだけが sendUpdates に
 * "The default is false." と書いているが、これは3値の enum に対する boolean の残骸で
 * patch/update には無い。
 * 分からない以上、**利用者に見える挙動を未文書の既定に委ねない**のが唯一の結論になる ――
 * サーバーは受け取らなかった場合に `externalOnly` を明示的に補って Google に渡す
 * (core/patch-event.ts の resolveSendUpdates)。MCP の update_event のように問いかける
 * 相手がいない経路でも、「頼まれてもいないメールを出さない・外部のカレンダーは古いまま
 * にしない」の両方を満たす唯一の値がこれ。
 */
export type EventSendUpdates = "all" | "externalOnly";

export interface EventPatchRequest {
  accountId: string;
  calendarId: string;
  eventId: string;
  /**
   * 変更後の時間帯 (epoch ms)。**startMs と endMs は「両方指定」か「両方省略」のどちらか**で、
   * 省略した場合は PATCH body に start/end を含めない = Google 側の時刻をそのまま保つ
   * (2026-07-30、繰り返し予定の適用範囲)。
   *
   * なぜ省略できる必要があるか: 繰り返し予定の内容 (タイトル等) だけを「すべての予定」に
   * 適用するとき、親イベントの start は DTSTART そのもの ―― 何も動かさないつもりでも時刻を
   * 送れば、ローカルに持っている分精度の値で DTSTART を書き直してしまう。時刻を触らない
   * 変更では**送らない**のが唯一安全な選択肢になる。
   */
  startMs?: number;
  endMs?: number;
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
  /**
   * ゲストへの通知 (2026-07-31)。EventSendUpdates のコメント参照。
   * **未指定なら サーバーが `externalOnly` を補う** ―― Google の未文書の既定に委ねない。
   * web は必ず値を入れて送る (sync/recurrenceScope.ts の buildScopedEventPatchRequest が
   * 唯一の組み立て口で、そこで resolveSendUpdates が必ず解決する)。
   */
  sendUpdates?: EventSendUpdates;
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
 * POST /api/event/guests — 予定のゲスト (参加者) を追加・削除する (2026-07-31)。
 *
 * ## 配列ではなく差分を送る
 * `events.patch` の attendees は**全置換**で、公式にも "Array fields, if specified,
 * overwrite the existing arrays; this discards any previous array elements" と明記がある。
 * それでいてクライアントが持つ一覧は MAX_DTO_ATTENDEES (50) 件で打ち切られていることが
 * あるため、**クライアントに配列を組ませてはいけない** ―― 手元に無い参加者を巻き添えで
 * 全員消してしまう。そこで「このメールを足す/外す」という差分だけを送り、
 * `events.get` → 差分適用 → `events.patch` の read-modify-write はサーバーが行う
 * (core/guest-event.ts)。RSVP (EventRsvpRequest) と同じ考え方。
 *
 * ## 主催者のときだけ通す
 * 公式の Event propagation に「The only event change that is propagated from attendees
 * back to the organizer is the attendee's response status」とあり、参加者側の複製で
 * attendees を書き換えても主催者には伝わらない (しかも API がそれを 403 で拒むのか
 * 200 で自分の複製だけ変えるのかは**公式に書かれていない**)。サーバーは events.get の
 * `organizer.self` を見て、主催者でなければ **422 not_organizer** を返す ―― 挙動が
 * 定義されていない書き込みは行わない。クライアント側 (web の canEditGuests) も
 * 同じ条件で導線を出さないが、権限の判断はこちらが正本。
 *
 * ## sendUpdates は常に all
 * 詳細は google/guests-raw.ts の patchGuestsRaw のコメント参照 ―― 要約すると
 * `none` / `externalOnly` は「招待が誰にも届かないまま一覧にだけ人が増える」経路を作るため、
 * この操作では選択肢にしない。
 */
export interface EventGuestsRequest {
  accountId: string;
  calendarId: string;
  eventId: string;
  /** 追加するメールアドレス。空配列/未指定なら追加しない (add/remove の両方が空なら 400) */
  addEmails?: string[];
  /**
   * 外すメールアドレス。**自分自身・主催者・会議室 (resource) は外せない** ――
   * 該当する行は要求されてもサーバー側で無視する (core/guest-edit.ts の applyGuestChanges)。
   */
  removeEmails?: string[];
}

export interface EventGuestsResponse {
  ok: boolean;
}

/**
 * POST /api/event/create — 新規予定を Google に作成 (フェーズ5、2026-07-29 全項目入力に拡張)。
 * 作成結果の正本は次の同期 (SSE changed → /api/sync) で還流するが、UI の
 * 楽観的表示のため作成された eventId を即時に返す。
 *
 * location/description/isAllDay は optional な拡張 — 未指定の旧クライアント
 * (タイトルと時間帯だけ送るリクエスト) もそのまま動く (後方互換)。EventPatchRequest と違い
 * **空文字は送らない想定**: 作成には「クリアすべき既存値」が無いので、空欄はキー自体を
 * 省略して Google のデフォルト (場所/説明なし) に任せる (web の buildEventCreateRequest 参照)。
 * 空文字が届いた場合も Google 上は未設定と同じ扱いになるため、サーバーは弾かない。
 */
export interface EventCreateRequest {
  accountId: string;
  calendarId: string;
  title: string;
  /** 終日予定 (isAllDay: true) では「開始日のローカル 0:00」を渡す */
  startMs: number;
  /**
   * 終日予定 (isAllDay: true) では「終了日 (inclusive) の翌日のローカル 0:00」= 排他的な終了。
   * Google の end.date と同じ規約 (EventPatchRequest / google/patch-event.ts の toDateOnly と同じ)。
   */
  endMs: number;
  /** クライアントの IANA タイムゾーン (dateTime と併記。isAllDay の date 変換にも使う) */
  timeZone: string;
  /** 場所。未指定なら設定しない。 */
  location?: string;
  /** 説明。未指定なら設定しない。 */
  description?: string;
  /**
   * true なら終日予定として start/end を Google の `date` (YYYY-MM-DD) 形式で送る
   * (startMs/endMs を timeZone で日付に変換する)。false/未指定は `dateTime` (時刻予定)。
   */
  isAllDay?: boolean;
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
  /**
   * true = このルールが Google カレンダーに作った「予定あり」のミラー予定も削除する。
   *
   * **省略時は false**(対応表の行だけ消し、Google 側の予定は残す)。既定を「消さない」に
   * するのは、省略で届くリクエスト = 旧クライアント・MCP・手書きの curl であり、そこへ
   * 「頼んでいない削除」を黙って走らせないため。破壊的操作は常に明示的なオプトインで行う。
   * 削除 UI は既定チェック済みのチェックボックスで常に true/false を明示して送る
   * (利用者の目の前で選べる場面と、選ぶ機会が無い場面とで既定を変えている)。
   */
  deleteMirrors?: boolean;
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
 *
 * エラー応答 (2026-07-25 追記):
 *  - 400 invalid_json / missing_fields / missing_repo / invalid_start / invalid_end /
 *    start_not_before_end — 形と値の検証 (start<end は start と end の両方が来たときだけ判定する)。
 *  - 403 work_log_not_found — 存在しない id / 他プロファイルの id (上記のとおり区別しない)。
 *  - 409 **work_log_conflict** — 実行中 (end_ms IS NULL) の行の repo/issueRef を、既に別の開区間が
 *    走っているキーへ変更しようとした (0011 の部分ユニークインデックス idx_work_logs_open と
 *    両立しない)。入力自体は正しく現在の DB 状態とだけ両立しないため 400 ではなく 409。
 *    クライアントは「別の開始中と衝突した」旨を出して、リトライではなく入力の訂正を促せばよい。
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
