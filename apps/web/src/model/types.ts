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
  /**
   * hook 実績 (docs/mcp.md「エージェントの作業時間記録」、log_work_interval が「kichijitsu 実績」
   * カレンダーに書くイベント) かどうかの軽量マーカー。true 相当は
   * extendedProperties.private.kichijitsuWorkLog==='1' のイベントのみで、mapGoogle.ts が
   * buildSingle 内でこのフィールドに写す (isMirror と同じパス、buildAllDay/buildSeries/
   * buildOverride 側には付けない — work-log.ts の buildWorkLogEvent は常に単発の
   * dateTime イベントしか作らないため)。
   * repo は extendedProperties.private.repo をそのまま、issueRef は同 issueRef を
   * そのまま(数値文字列とは限らない — ブランチ名由来の非数値の場合もある。数値判定・
   * 突合は sync/hookActual.ts が行う)。省略時は undefined (=hook 実績ではない)。
   */
  workLog?: { repo: string; issueRef?: string };
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
export type GitHubItemType = "milestone" | "issue" | "pr" | "release";

/**
 * GitHubItemDTO の保存用モデル。Occurrence/TaskItem と違い、DTO から構造を
 * 変換する必要が無い (id/type/title/dateMs/repo/number/url/milestoneTitle を
 * そのまま持つだけ) ため、フィールド構成は DTO と同一。
 *
 * 展開ウィンドウの概念が無く(AllDayOccurrence/TaskItem と同様)、取得の都度
 * 全件で置き換える運用(サーバーが GitHub アイテムを永続化しないため、
 * 毎回のフェッチが常に完全なスナップショットになる)。
 *
 * release アイテム(docs/github-integration.md フェーズ④「first cut」、2026-07-20)は
 * milestoneTitle を持たず、number は常に 0(GitHub の release には issue 的な番号が無いため、
 * 一意性は id のタグ由来部分が担う)。
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

/**
 * 予定タイムブロック (docs/github-integration.md「時間計測」増分1、2026-07-20)。
 * 作業キュー(GitHubWorkItemDTO)の項目をグリッドへドラッグして作る、**Google に一切
 * 書き戻さないローカル専用**の予定。Occurrence/AllDayOccurrence とは別の独立ストア・
 * 別 IndexedDB store (`plannedBlocks`) に置くことで、Google 同期 (applySync 等) の
 * 全消し→全書き込みに巻き込まれない(=同期のたびに消えたりしない)。
 *
 * linkedItemId で紐づく元の GitHubWorkItemDTO はサーバー側で永続化されず作業キューが
 * 消えても表示を保てるよう、表示に必要な最小限 (itemType/title/repo/number/url) を
 * 非正規化してこちら側にも持つ。実績(commit)との突き合わせ・レポートは増分2でやる
 * (このモデルは「予定」のみ、実績フィールドは持たない)。
 */
export interface PlannedBlock {
  id: string;
  startMs: number;
  endMs: number;
  /** 紐づく GitHubWorkItem の id (`ghq:{owner}/{repo}:{issue|pr}:{number}`) */
  linkedItemId: string;
  itemType: "issue" | "pr";
  title: string;
  /** "owner/repo" */
  repo: string;
  number: number;
  /** html_url。クリックで新規タブに開く */
  url: string;
}

/**
 * 手動タイマーで記録する実績エントリ (docs/github-integration.md「時間計測」増分2、
 * 2026-07-20)。PlannedBlock が「予定」を表すのに対し、こちらは「実績」— ▶/⏹ の
 * 手動操作で作られる、**Google に一切書き戻さないローカル専用**の時間記録。
 *
 * PlannedBlock と同じく、レポートが元の作業アイテムが消えた後も成立するよう
 * itemType/title/repo/number/url を非正規化して持つ。同一 linkedItemId につき
 * 複数の TimeEntry を持てる(同時に複数 item を並行計測できる、単一走行の制約は無い)。
 * ただし同一 linkedItemId で endMs===null (走行中) のエントリは高々1件
 * (store.isRunning/getRunningEntries が前提とする不変条件、二重防止は App 側のハンドラが担う)。
 *
 * commit からの実績自動推定は増分3の別データ(このモデルは手動タイマーのみを表す)。
 */
export interface TimeEntry {
  id: string;
  /** 紐づく GitHub 作業アイテムの id (PlannedBlock.linkedItemId と同じ体系) */
  linkedItemId: string;
  itemType: "issue" | "pr";
  title: string;
  /** "owner/repo" */
  repo: string;
  number: number;
  /** html_url。クリックで新規タブに開く */
  url: string;
  startMs: number;
  /** null = 走行中。stopTimer() で確定値が入る */
  endMs: number | null;
}
