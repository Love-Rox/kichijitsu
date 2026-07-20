/** occurrence の出自。UI はソースをほぼ意識せず、source と link だけで扱う */
export type OccurrenceSource = "local" | "google" | "github";

/** クリックで元リソース（GitHub の PR 等）へ飛ぶための参照 */
export interface OccurrenceLink {
  url: string;
  label?: string;
}

/**
 * 展開済み occurrence。IndexedDB に入る最小単位で、UI はこれだけを読む。
 * 時刻は epoch ms (UTC instant) — IndexedDB の範囲インデックスは数値が最速。
 * タイムゾーン変換は表示層で Temporal を使って行う。
 */
export interface Occurrence {
  id: string;
  /** 繰り返しシリーズ由来なら親 series の id、単発なら null */
  seriesId: string | null;
  title: string;
  startMs: number;
  endMs: number;
  color: string;
  /**
   * true なら color はイベント個別色 (Google の colorId 由来) で、表示時も
   * そのまま使う。false/undefined なら color は同期時点のフォールバック焼き込み値
   * に過ぎず、表示は calendarLookup のカレンダー色を優先する
   * (layout/eventColors.ts の resolveDisplayColor 参照)
   */
  hasCustomColor?: boolean;
  source: OccurrenceSource;
  link?: OccurrenceLink;
  /**
   * シリーズ由来の場合のみ: 展開時の元の開始時刻 (epoch ms)。
   * ドラッグ等で startMs が変わっても不変で、InstanceOverride との対応付けに使う
   */
  originalStartMs?: number;
  /** Google 由来のみ: どのアカウントのどのカレンダーか。表示トグルと削除の単位 */
  accountId?: string;
  calendarId?: string;
  /** 同一予定の集約キー (Google iCalUID)。共有・招待の重複表示をまとめる */
  iCalUID?: string;
  /** ホバー/詳細表示用。location は会議室・住所・URL 等 */
  location?: string;
  description?: string;
  /**
   * カレンダーブロック機能 (docs/blocking.md) が生成した mirror (`予定あり`、
   * extendedProperties.private.kichijitsuMirror='1') かどうか。true は
   * mapGoogle.ts が付与する。省略時は undefined (=false 相当、通常の予定や
   * ユーザーが手動で作った「予定あり」はこのフラグを持たない)。
   * UI (EventBlock.tsx) はこれを見て「自動生成」の印と説明文を出す。
   */
  isMirror?: boolean;
}

/**
 * 終日予定は時刻を持たない日付として別レイヤーで扱う（UTC変換に巻き込まない）。
 * startDate/endDate は ISO 8601 calendar date (YYYY-MM-DD) の文字列で、
 * 両端 inclusive (endDate 当日を含む) — Google の end.date は排他的だが、
 * mapGoogle が取り込み時に inclusive へ正規化してここに格納する。
 */
export interface AllDayOccurrence {
  id: string;
  /** 繰り返しシリーズ由来なら親 series の id。終日の繰り返しは初版未対応のため常に null */
  seriesId: string | null;
  title: string;
  /** ISO 8601 calendar date, e.g. "2026-07-19" (開始日、inclusive) */
  startDate: string;
  /** ISO 8601 calendar date (終了日、inclusive。単日イベントは startDate と同じ) */
  endDate: string;
  color: string;
  /** Occurrence.hasCustomColor と同じ意味 (resolveDisplayColor 参照) */
  hasCustomColor?: boolean;
  source: OccurrenceSource;
  link?: OccurrenceLink;
  /** Google 由来のみ: どのアカウントのどのカレンダーか。表示トグルと削除の単位 */
  accountId?: string;
  calendarId?: string;
  /** 同一予定の集約キー (Google iCalUID)。共有・招待の重複表示をまとめる */
  iCalUID?: string;
  /** ホバー/詳細表示用 */
  location?: string;
  description?: string;
  /** Occurrence.isMirror と同じ意味 (カレンダーブロック機能の自動生成 mirror かどうか) */
  isMirror?: boolean;
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
  id: string;
  accountId: string;
  taskListId: string;
  title: string;
  /** ISO 8601 calendar date (YYYY-MM-DD)。due 無しタスクは null (v1 は日付レーンに表示しない) */
  dueDate: string | null;
  status: "needsAction" | "completed";
  notes?: string;
}

/**
 * GitHub 連携 (docs/github-integration.md フェーズ①、2026-07-20) の1アイテム。
 * milestone / issue / PR の種別を表す。TaskItem.status のように、web 側の
 * モデル層は wire DTO (GitHubItemDTO) から意図的に切り離す (protocol.ts に依存しない)。
 */
export type GitHubItemType = "milestone" | "issue" | "pr";

/**
 * GitHubItemDTO の保存用モデル。Occurrence/TaskItem と違い、DTO から構造を
 * 変換する必要が無い (id/type/title/dateMs/repo/number/url/milestoneTitle を
 * そのまま持つだけ) ため、フィールド構成は DTO と同一。
 *
 * 展開ウィンドウの概念が無く(AllDayOccurrence/TaskItem と同様)、取得の都度
 * 全件で置き換える運用(サーバーが GitHub アイテムを永続化しないため、
 * 毎回のフェッチが常に完全なスナップショットになる)。
 */
export interface GitHubItem {
  id: string;
  type: GitHubItemType;
  title: string;
  /** 期日 (milestone の due_on を epoch ms 化したもの)。issue/PR は所属 milestone の期日を継承する */
  dateMs: number;
  /** "owner/repo" */
  repo: string;
  number: number;
  /** html_url。クリックで新規タブで開く */
  url: string;
  /** issue/PR が属する milestone のタイトル。milestone 自身のアイテムには付かない */
  milestoneTitle?: string;
}
