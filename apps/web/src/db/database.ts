import { openDB } from "idb";
import type { DBSchema, IDBPDatabase } from "idb";
import type {
  AllDayOccurrence,
  GitHubItem,
  Occurrence,
  PlannedBlock,
  TaskItem,
  TimeEntry,
} from "../model/types";
import type { EventSeries, InstanceOverride } from "../model/series";
import type { ExpansionState } from "../expansion/windowPolicy";
import { DAY_MS } from "../expansion/windowPolicy";
import {
  DEFAULT_DECLINED_VISIBILITY,
  type DeclinedVisibilitySettings,
} from "../sync/declinedVisibility";

/**
 * IndexedDB (idb ラッパー) の薄いアクセス層。UI/展開ロジックはこれ経由でのみ
 * 永続化に触れる。スキーマ変更は必ずここの version を上げて upgrade で行う。
 */

/**
 * アカウントごとに選択中のカレンダー id 一覧。meta ストアに
 * key="visibleCalendars" で保存する(マルチアカウント対応 2026-07-19)。
 * 初回連携時はデフォルトで primary カレンダーのみが入る (App.tsx が設定)。
 */
export interface VisibleCalendarsMap {
  [accountId: string]: string[];
}

export interface KichijitsuDB extends DBSchema {
  occurrences: {
    key: string;
    value: Occurrence;
    indexes: { startMs: number };
  };
  /** 終日予定 (フェーズ5)。時刻予定と違い展開ウィンドウの概念が無いため全件を常時ロードする */
  allDayOccurrences: {
    key: string;
    value: AllDayOccurrence;
    indexes: { startDate: string };
  };
  /**
   * Google タスク (docs/google-tasks.md、2026-07-20)。allDayOccurrences と同じく
   * 展開ウィンドウの概念が無いため全件を常時ロードする
   */
  tasks: {
    key: string;
    value: TaskItem;
    indexes: { dueDate: string };
  };
  series: {
    key: string;
    value: EventSeries;
  };
  overrides: {
    key: string;
    value: InstanceOverride;
  };
  /**
   * GitHub 連携 (docs/github-integration.md フェーズ①Part B、2026-07-20) の
   * milestone/issue/PR アイテム。allDayOccurrences/tasks と同様、展開ウィンドウの概念が
   * 無いため全件を常時ロードする。サーバーが永続化しない(取得の都度スナップショット)ため、
   * 取得成功のたびに丸ごと置き換える運用(App.tsx 参照)
   */
  githubItems: {
    key: string;
    value: GitHubItem;
  };
  /**
   * 予定タイムブロック (docs/github-integration.md「時間計測」増分1、2026-07-20)。
   * occurrences とは完全に独立したストア — Google 同期はこのストアに一切触れない
   * (applySync 等が occurrences/allDayOccurrences/tasks/githubItems だけを触る隔離を守るため)。
   * githubItems と同様に展開ウィンドウの概念が無く、起動時に全件を常時ロードする運用
   */
  plannedBlocks: {
    key: string;
    value: PlannedBlock;
  };
  /**
   * 手動タイマーの実績エントリ (docs/github-integration.md「時間計測」増分2、2026-07-20)。
   * plannedBlocks と同様 Google 同期からは完全に独立し、展開ウィンドウの概念も無いため
   * 全件を常時ロードする運用。走行中(endMs===null)のエントリも含めてそのまま保存する
   * (start 時点で put し、stop 時に endMs を埋めて再度 put する2段書き込み)。
   */
  timeEntries: {
    key: string;
    value: TimeEntry;
  };
  /** out-of-line key の雑多な設定置き場。key ごとに value の形が異なる (下記関数群参照) */
  meta: {
    key: string;
    value:
      | ExpansionState
      | VisibleCalendarsMap
      | DeclinedVisibilitySettings
      | string
      | string[]
      | number
      | boolean;
  };
}

const DB_NAME = "kichijitsu";
/** テスト (fake-indexeddb 上に openDB する場合など) からもスキーマ版数を参照できるよう公開 */
export const DB_VERSION = 6;
const META_EXPANSION_KEY = "expansion";
const META_VISIBLE_CALENDARS_KEY = "visibleCalendars";
/**
 * 端末ごと syncToken (2026-07-21): サーバー (UserSyncDO) の sync_tokens_v2 が
 * (calendar_id, device_id) 単位でトークンを持つようになったのに対応し、クライアント側で
 * この端末を識別する UUID を1つ永続化する。ブラウザプロファイル/Tauri webview ごとに
 * IndexedDB は独立しているため、これが実質「端末」の粒度になる。
 */
const META_DEVICE_ID_KEY = "deviceId";
/**
 * タスクリスト表示 ON/OFF (左ペイン増分2、2026-07-22)。カレンダー選択 (visibleCalendars) と
 * 非対称に、サーバー同期はせずこの端末だけのローカル永続にする(v1、詳細は
 * getHiddenTaskLists のコメント参照)。
 */
const META_HIDDEN_TASK_LISTS_KEY = "hiddenTaskLists";
/**
 * 「不参加 (declined) の予定を表示しない」設定 (参加ステータス表示、2026-07-22)。
 * hiddenTaskLists と同じく、この端末だけのローカル永続(サーバー同期はしない)。
 * 未保存時の既定値は sync/declinedVisibility.ts の DEFAULT_DECLINED_VISIBILITY
 * (showDeclined: true = 現状維持)。
 */
const META_DECLINED_VISIBILITY_KEY = "declinedVisibility";
/**
 * 同期バックフィル世代 (2026-07-22、旧 oooBackfillDone の一般化)。当初は eventType
 * (不在レール表示、a00fa80) 専用の boolean フラグだったが、RSVP 表示 (selfResponseStatus/
 * isOrganizer/hasConference) の追加で「クライアント側だけで新フィールドを増やすたびに、
 * 過去に同期済みのイベントへ行き渡らせる」という同じ課題が再発したため、世代番号
 * (syncBackfillVersion) に一般化した ―― 新フィールドを追加するたびに CURRENT_SYNC_BACKFILL_VERSION
 * を1つ上げるだけで、App.tsx の runSyncBackfillIfNeeded が保存済み世代との差分を forceFull
 * 同期で埋める(旧 runOooBackfillIfNeeded と同じ仕組み、対象は常に「保存済み世代 → 現行世代」への
 * 1ジャンプ)。deviceId と同じく端末ごとの IndexedDB に保存する — 複数端末はそれぞれ自分の
 * syncToken (v2) を持つ設計なので、バックフィルも各端末が自分の分を1回ずつ実施するのが正しい
 * (他端末の完了を「もう済んだ」と誤認してはいけない)。
 *
 * 世代の意味:
 *   1 = eventType (不在レール表示、2026-07-22、旧 oooBackfillDone===true と同値)
 *   2 = RSVP 表示 (selfResponseStatus/isOrganizer/hasConference、2026-07-22)
 *   3 = isWorkingLocation (勤務場所の控えめ表示、2026-07-22)。eventType 自体は世代1の
 *       時点で既にサーバー応答に載って行き渡っている(GoogleEventDTO.eventType は
 *       events.list が常に返すフィールドのため)が、mapGoogle.ts が occurrence/
 *       series/override へ isWorkingLocation として「写す」処理は今回追加したもの ――
 *       世代1・2の時点で既に同期済みだった occurrence にはこのフラグがまだ乗っていない。
 *       eventType 自体のバックフィルとは別に、このフィールドぶんだけ改めて forceFull
 *       同期で行き渡らせる必要があるため世代を1つ上げる(RSVP フィールド追加のときと
 *       全く同じ理由、上の世代2のコメント参照)。
 */
const META_OOO_BACKFILL_DONE_KEY = "oooBackfillDone"; // 旧キー。getSyncBackfillVersion の移行判定でのみ読む
const META_SYNC_BACKFILL_VERSION_KEY = "syncBackfillVersion";
export const CURRENT_SYNC_BACKFILL_VERSION = 3;

let dbPromise: Promise<IDBPDatabase<KichijitsuDB>> | undefined;

/**
 * openKichijitsuDB の upgrade コールバック本体。テスト (applySync 系の全同期アトミック性
 * テストなど) が fake-indexeddb 上に同じスキーマの DB を独立して作れるよう、
 * openDB 呼び出しから切り出してエクスポートする(挙動は従来と同一)。
 */
export function upgradeKichijitsuSchema(db: IDBPDatabase<KichijitsuDB>): void {
  if (!db.objectStoreNames.contains("occurrences")) {
    const store = db.createObjectStore("occurrences", { keyPath: "id" });
    store.createIndex("startMs", "startMs");
  }
  if (!db.objectStoreNames.contains("allDayOccurrences")) {
    // DB_VERSION 2 (フェーズ5) で追加。既存ユーザーもここを通って新規作成される
    const store = db.createObjectStore("allDayOccurrences", { keyPath: "id" });
    store.createIndex("startDate", "startDate");
  }
  if (!db.objectStoreNames.contains("tasks")) {
    // DB_VERSION 3 (Google タスク連携、docs/google-tasks.md) で追加
    const store = db.createObjectStore("tasks", { keyPath: "id" });
    store.createIndex("dueDate", "dueDate");
  }
  if (!db.objectStoreNames.contains("series")) {
    db.createObjectStore("series", { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains("overrides")) {
    db.createObjectStore("overrides", { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains("githubItems")) {
    // DB_VERSION 4 (GitHub 連携フェーズ①Part B) で追加。既存ユーザーもここを通って新規作成される
    db.createObjectStore("githubItems", { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains("plannedBlocks")) {
    // DB_VERSION 5 (GitHub 連携「時間計測」増分1) で追加。既存ユーザー(v4 以前)も
    // ここを通って新規作成される。他ストアとは独立(Google 同期は触れない)
    db.createObjectStore("plannedBlocks", { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains("timeEntries")) {
    // DB_VERSION 6 (GitHub 連携「時間計測」増分2) で追加。既存ユーザー(v5 以前)も
    // ここを通って新規作成される。plannedBlocks と同じく他ストアとは独立
    db.createObjectStore("timeEntries", { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains("meta")) {
    // out-of-line key: put 時に key を明示して渡す (keyPath なし)
    db.createObjectStore("meta");
  }
}

/** DB 接続を開く(メモ化: 同一プロセス内では1接続を使い回す) */
export async function openKichijitsuDB(): Promise<IDBPDatabase<KichijitsuDB>> {
  if (!dbPromise) {
    dbPromise = openDB<KichijitsuDB>(DB_NAME, DB_VERSION, {
      upgrade: upgradeKichijitsuSchema,
    });
  }
  return dbPromise;
}

export async function getAllSeries(db: IDBPDatabase<KichijitsuDB>): Promise<EventSeries[]> {
  return db.getAll("series");
}

export async function putSeries(
  db: IDBPDatabase<KichijitsuDB>,
  series: EventSeries | EventSeries[],
): Promise<void> {
  const list = Array.isArray(series) ? series : [series];
  const tx = db.transaction("series", "readwrite");
  await Promise.all([...list.map((s) => tx.store.put(s)), tx.done]);
}

export async function getAllOverrides(db: IDBPDatabase<KichijitsuDB>): Promise<InstanceOverride[]> {
  return db.getAll("overrides");
}

/** 単一 override の取得(フェーズ5: Google 書き戻し失敗時のロールバックで「変更前の override」を覚えておくのに使う) */
export async function getOverride(
  db: IDBPDatabase<KichijitsuDB>,
  id: string,
): Promise<InstanceOverride | undefined> {
  return db.get("overrides", id);
}

export async function putOverride(
  db: IDBPDatabase<KichijitsuDB>,
  override: InstanceOverride,
): Promise<void> {
  await db.put("overrides", override);
}

export async function deleteSeriesByIds(
  db: IDBPDatabase<KichijitsuDB>,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const tx = db.transaction("series", "readwrite");
  await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
}

export async function deleteOverridesByIds(
  db: IDBPDatabase<KichijitsuDB>,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const tx = db.transaction("overrides", "readwrite");
  await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
}

/** 単一トランザクションでの bulk 書き込み */
export async function putOccurrences(
  db: IDBPDatabase<KichijitsuDB>,
  occurrences: Occurrence[],
): Promise<void> {
  const tx = db.transaction("occurrences", "readwrite");
  await Promise.all([...occurrences.map((o) => tx.store.put(o)), tx.done]);
}

export async function putOccurrence(
  db: IDBPDatabase<KichijitsuDB>,
  occurrence: Occurrence,
): Promise<void> {
  await db.put("occurrences", occurrence);
}

export async function getAllOccurrences(db: IDBPDatabase<KichijitsuDB>): Promise<Occurrence[]> {
  return db.getAll("occurrences");
}

export async function deleteOccurrencesByIds(
  db: IDBPDatabase<KichijitsuDB>,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const tx = db.transaction("occurrences", "readwrite");
  await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
}

/** 単一トランザクションでの bulk 書き込み(終日予定) */
export async function putAllDayOccurrences(
  db: IDBPDatabase<KichijitsuDB>,
  allDayOccurrences: AllDayOccurrence[],
): Promise<void> {
  if (allDayOccurrences.length === 0) return;
  const tx = db.transaction("allDayOccurrences", "readwrite");
  await Promise.all([...allDayOccurrences.map((o) => tx.store.put(o)), tx.done]);
}

/**
 * 終日予定は展開ウィンドウの概念が無い(繰り返しは初版未対応なので、素直に
 * 全件が実データ)ため、時刻予定のような範囲クエリではなく全件取得で読み込む。
 * 起動時に AllDayStore へ丸ごとロードする用途
 */
export async function getAllAllDayOccurrences(
  db: IDBPDatabase<KichijitsuDB>,
): Promise<AllDayOccurrence[]> {
  return db.getAll("allDayOccurrences");
}

export async function deleteAllDayOccurrencesByIds(
  db: IDBPDatabase<KichijitsuDB>,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const tx = db.transaction("allDayOccurrences", "readwrite");
  await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
}

/** 単一トランザクションでの bulk 書き込み(Google タスク) */
export async function putTasks(db: IDBPDatabase<KichijitsuDB>, tasks: TaskItem[]): Promise<void> {
  if (tasks.length === 0) return;
  const tx = db.transaction("tasks", "readwrite");
  await Promise.all([...tasks.map((t) => tx.store.put(t)), tx.done]);
}

export async function putTask(db: IDBPDatabase<KichijitsuDB>, task: TaskItem): Promise<void> {
  await db.put("tasks", task);
}

/**
 * タスクも終日予定と同様に展開ウィンドウの概念が無いため全件取得で読み込む
 * (起動時に丸ごと TaskStore へロードする用途)
 */
export async function getAllTasks(db: IDBPDatabase<KichijitsuDB>): Promise<TaskItem[]> {
  return db.getAll("tasks");
}

export async function deleteTasksByIds(
  db: IDBPDatabase<KichijitsuDB>,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const tx = db.transaction("tasks", "readwrite");
  await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
}

/**
 * 単一トランザクションでの bulk 書き込み(GitHub アイテム)。putTasks と同じ流儀
 * (allDayOccurrences 系の putAllDayOccurrences に倣う)
 */
export async function putGitHubItems(
  db: IDBPDatabase<KichijitsuDB>,
  items: GitHubItem[],
): Promise<void> {
  if (items.length === 0) return;
  const tx = db.transaction("githubItems", "readwrite");
  await Promise.all([...items.map((i) => tx.store.put(i)), tx.done]);
}

/**
 * GitHub アイテムも終日予定/タスクと同様に展開ウィンドウの概念が無いため全件取得で読み込む
 * (起動時に丸ごと GitHubStore へロードする用途)
 */
export async function getAllGitHubItems(db: IDBPDatabase<KichijitsuDB>): Promise<GitHubItem[]> {
  return db.getAll("githubItems");
}

/**
 * githubItems ストアを丸ごと空にする。サーバーが GitHub アイテムを永続化せず、
 * GET /api/github/items が常に完全なスナップショットを返す設計 (docs/github-integration.md)
 * のため、取得成功のたびに「全消し→全書き込み」で置き換える(差分削除の必要が無い)。
 * 連携解除 (DELETE /api/github) 時のローカルデータ削除にも使う。
 */
export async function clearGitHubItems(db: IDBPDatabase<KichijitsuDB>): Promise<void> {
  await db.clear("githubItems");
}

/**
 * 予定タイムブロック (docs/github-integration.md「時間計測」増分1)。githubItems 系と同様、
 * 展開ウィンドウの概念が無いため全件取得で読み込む(起動時に丸ごと PlannedStore へロードする用途)。
 */
export async function getAllPlannedBlocks(db: IDBPDatabase<KichijitsuDB>): Promise<PlannedBlock[]> {
  return db.getAll("plannedBlocks");
}

/** 1件の作成・更新(ドラッグでの新規作成・移動・リサイズ、いずれもローカルのみ) */
export async function putPlannedBlock(
  db: IDBPDatabase<KichijitsuDB>,
  block: PlannedBlock,
): Promise<void> {
  await db.put("plannedBlocks", block);
}

/** 削除ボタンから呼ばれる(ローカルのみ、Google への書き戻し無し) */
export async function deletePlannedBlock(
  db: IDBPDatabase<KichijitsuDB>,
  id: string,
): Promise<void> {
  await db.delete("plannedBlocks", id);
}

/**
 * 手動タイマーの実績エントリ (docs/github-integration.md「時間計測」増分2)。plannedBlocks 系と
 * 同様、展開ウィンドウの概念が無いため全件取得で読み込む(起動時に丸ごと TimeEntryStore へ
 * ロードする用途)。
 */
export async function getAllTimeEntries(db: IDBPDatabase<KichijitsuDB>): Promise<TimeEntry[]> {
  return db.getAll("timeEntries");
}

/** 1件の作成・更新(▶ での開始・⏹ での確定、いずれもローカルのみ) */
export async function putTimeEntry(
  db: IDBPDatabase<KichijitsuDB>,
  entry: TimeEntry,
): Promise<void> {
  await db.put("timeEntries", entry);
}

/** 現状 UI からは呼ばれないが、plannedBlocks の delete と対にして用意しておく */
export async function deleteTimeEntry(db: IDBPDatabase<KichijitsuDB>, id: string): Promise<void> {
  await db.delete("timeEntries", id);
}

/**
 * [fromMs, toMs) に重なる occurrence を返す。
 * startMs インデックスの範囲クエリでは「開始が fromMs より前だが範囲に食い込む」
 * イベントを取りこぼすため、fromMs - 24h まで下限を広げてから拾い、
 * 最後に実際の重なり判定で絞り込む。
 */
export async function getOccurrencesBetween(
  db: IDBPDatabase<KichijitsuDB>,
  fromMs: number,
  toMs: number,
): Promise<Occurrence[]> {
  const lowerBound = fromMs - DAY_MS;
  const range = IDBKeyRange.bound(lowerBound, toMs, false, true);
  const candidates = await db.getAllFromIndex("occurrences", "startMs", range);
  return candidates.filter((o) => o.startMs < toMs && o.endMs > fromMs);
}

export async function getExpansionState(
  db: IDBPDatabase<KichijitsuDB>,
): Promise<ExpansionState | null> {
  const state = await db.get("meta", META_EXPANSION_KEY);
  // meta ストアは key ごとに value の形が違う(VisibleCalendarsMap と共存)ため、
  // ExpansionState の形をしているかを軽くチェックしてから返す
  if (!state || typeof state !== "object" || !("expandedFromMs" in state)) return null;
  return state as ExpansionState;
}

export async function setExpansionState(
  db: IDBPDatabase<KichijitsuDB>,
  state: ExpansionState,
): Promise<void> {
  await db.put("meta", state, META_EXPANSION_KEY);
}

/** 保存済みの選択中カレンダー一覧。未保存なら空オブジェクト */
export async function getVisibleCalendars(
  db: IDBPDatabase<KichijitsuDB>,
): Promise<VisibleCalendarsMap> {
  const value = await db.get("meta", META_VISIBLE_CALENDARS_KEY);
  // meta ストアは key ごとに value の形が違う(ExpansionState と共存)ため、
  // ExpansionState を誤って返さないよう軽く形をチェックする
  if (!value || typeof value !== "object" || "expandedFromMs" in value) return {};
  return value as VisibleCalendarsMap;
}

export async function setVisibleCalendars(
  db: IDBPDatabase<KichijitsuDB>,
  visibleCalendars: VisibleCalendarsMap,
): Promise<void> {
  await db.put("meta", visibleCalendars, META_VISIBLE_CALENDARS_KEY);
}

/**
 * この端末の deviceId を返す。無ければ crypto.randomUUID() で生成して meta ストアに
 * 保存してから返す (端末ごと syncToken、2026-07-21)。以後この IndexedDB が存続する限り
 * 同じ値を返し続ける — 一度発行した deviceId を変えると、サーバー側 (sync_tokens_v2) は
 * 別端末として扱い、この端末はまた最初から (レガシー共有トークンを seed として)
 * 同期し直すことになる。
 */
export async function getOrCreateDeviceId(db: IDBPDatabase<KichijitsuDB>): Promise<string> {
  const existing = await db.get("meta", META_DEVICE_ID_KEY);
  if (typeof existing === "string" && existing.length > 0) return existing;
  const id = crypto.randomUUID();
  await db.put("meta", id, META_DEVICE_ID_KEY);
  return id;
}

/**
 * タスクリスト表示 ON/OFF (左ペイン増分2、2026-07-22、docs/google-tasks.md の TODO 解消)。
 * カレンダーの visibleCalendars (「表示中の id 配列」を保存) とは意図的に逆で、
 * 「明示的に非表示にした `${accountId}:${taskListId}` の集合」を保存する。
 *
 * こうする理由: v1 の既存挙動(取得できた全タスクリストを常時表示)と自然に互換に
 * なるようにするため。「表示中の集合」を保存する方式だと、新しく増えたタスクリスト
 * (未知の id)は保存済み集合に無い=デフォルト非表示になってしまい、visibleCalendars と
 * 同じ「新規は追加操作するまで見えない」挙動になる。タスクリストは逆に「明示的に
 * OFF にしない限り常に見える」を既定にしたいため、保存するのを OFF 側の集合にする
 * (未保存 = 空集合 = 何も隠していない = 全 ON)。
 *
 * サーバー同期は行わない(v1、カレンダー選択と非対称。この端末のみのローカル設定 ――
 * 将来 PUT /api/visible-task-lists 相当を作って端末間同期する余地は残してあるが、
 * 今回はスコープ外)。表示フィルタのみで、タスクの同期(syncTaskList)自体はこの値と
 * 無関係に続行する(App.tsx の selectedTaskListTargets 参照 ―― 表示 OFF でも裏で最新化
 * しておくことで、再度 ON にした瞬間に古いデータが見えるのを防ぐ)。
 */
export async function getHiddenTaskLists(db: IDBPDatabase<KichijitsuDB>): Promise<Set<string>> {
  const value = await db.get("meta", META_HIDDEN_TASK_LISTS_KEY);
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((v): v is string => typeof v === "string"));
}

export async function setHiddenTaskLists(
  db: IDBPDatabase<KichijitsuDB>,
  hidden: ReadonlySet<string>,
): Promise<void> {
  await db.put("meta", [...hidden], META_HIDDEN_TASK_LISTS_KEY);
}

/**
 * 「不参加を表示」設定 (参加ステータス表示、2026-07-22) の読み出し。未保存なら
 * DEFAULT_DECLINED_VISIBILITY (showDeclined: true = 現状維持) を返す。meta ストアは
 * key ごとに value の形が異なる(他の設定と共存)ため、getExpansionState/
 * getVisibleCalendars と同じく「それらしい形をしているか」を軽くチェックしてから返す。
 */
export async function getDeclinedVisibilitySettings(
  db: IDBPDatabase<KichijitsuDB>,
): Promise<DeclinedVisibilitySettings> {
  const value = await db.get("meta", META_DECLINED_VISIBILITY_KEY);
  if (!value || typeof value !== "object" || !("showDeclined" in value)) {
    return DEFAULT_DECLINED_VISIBILITY;
  }
  return value as DeclinedVisibilitySettings;
}

export async function setDeclinedVisibilitySettings(
  db: IDBPDatabase<KichijitsuDB>,
  settings: DeclinedVisibilitySettings,
): Promise<void> {
  await db.put("meta", settings, META_DECLINED_VISIBILITY_KEY);
}

/**
 * 同期バックフィルの保存済み世代を返す (2026-07-22、旧 getOooBackfillDone の一般化)。
 *
 * 新キー (syncBackfillVersion) が無ければ、旧キー (oooBackfillDone、boolean) を移行判定する:
 * 旧キーが true なら「eventType バックフィル (世代1) までは完了済み」とみなして 1 を返す
 * (数値版導入前に完了していた端末が、RSVP 追加でまた eventType からやり直しにならないための
 * 救済)。旧キーも無ければ 0 (何も完了していない)。この移行判定はここで新キーへ書き込むことは
 * しない ―― setSyncBackfillVersion が呼ばれるまでは毎回この関数内で同じ判定を再実行するだけで、
 * 副作用が無い(=何度呼んでも安全)。
 */
export async function getSyncBackfillVersion(db: IDBPDatabase<KichijitsuDB>): Promise<number> {
  const value = await db.get("meta", META_SYNC_BACKFILL_VERSION_KEY);
  if (typeof value === "number") return value;
  const legacyDone = await db.get("meta", META_OOO_BACKFILL_DONE_KEY);
  return legacyDone === true ? 1 : 0;
}

/**
 * バックフィル完了を記録する。App.tsx 側は「選択中の全カレンダーへの forceFull 同期が
 * 1つも失敗せず終わった」ときのみこれを呼ぶ — 一部失敗した場合は呼ばずに次回起動時の
 * 再試行に委ねる (完了世代を早まって進めると、失敗したカレンダーだけ永久に
 * バックフィルされないままになるため)。
 */
export async function setSyncBackfillVersion(
  db: IDBPDatabase<KichijitsuDB>,
  version: number,
): Promise<void> {
  await db.put("meta", version, META_SYNC_BACKFILL_VERSION_KEY);
}

export async function countSeries(db: IDBPDatabase<KichijitsuDB>): Promise<number> {
  return db.count("series");
}

/** cleanupLegacyGoogleData の戻り値。全て 0 なら削除対象が無かった(冪等の2回目以降含む) */
export interface LegacyCleanupResult {
  seriesRemoved: number;
  occurrencesRemoved: number;
  overridesRemoved: number;
}

/**
 * レガシー Google データの掃除 (2026-07-19 の ID スコープ化 `g:<eventId>` →
 * `g:<accountId>:<calendarId>:<eventId>` 以前に保存された残骸)。
 *
 * 旧 ID 体系の series/occurrences は source==='google' なのに accountId が
 * 付いていない(現行のフィルタ `${accountId}:${calendarId}` にはどのみち
 * マッチしないので、どのみち不可視の残骸)。overrides は自身に source/accountId
 * を持たないため、代わりに seriesId が旧形式かどうかで判定する: 旧形式は
 * `g:<eventId>` (コロン区切り2セグメント)、新形式は `g:<accountId>:<calendarId>:<eventId>`
 * (4セグメント以上)なので、`g:` で始まり3セグメント未満なら旧形式とみなす。
 *
 * 起動のたびに呼んでよい設計(冪等): 一度掃除し終われば以降は全て 0 件で
 * 即 return する。呼び出し側は 0 件なら何もログを出さない想定。
 */
export async function cleanupLegacyGoogleData(
  db: IDBPDatabase<KichijitsuDB>,
): Promise<LegacyCleanupResult> {
  const [allSeries, allOccurrences, allOverrides] = await Promise.all([
    getAllSeries(db),
    getAllOccurrences(db),
    getAllOverrides(db),
  ]);

  const legacySeriesIds = allSeries
    .filter((s) => s.source === "google" && s.accountId === undefined)
    .map((s) => s.id);
  const legacyOccurrenceIds = allOccurrences
    .filter((o) => o.source === "google" && o.accountId === undefined)
    .map((o) => o.id);
  const legacyOverrideIds = allOverrides
    .filter((o) => o.seriesId.startsWith("g:") && o.seriesId.split(":").length < 3)
    .map((o) => o.id);

  if (
    legacySeriesIds.length === 0 &&
    legacyOccurrenceIds.length === 0 &&
    legacyOverrideIds.length === 0
  ) {
    return { seriesRemoved: 0, occurrencesRemoved: 0, overridesRemoved: 0 };
  }

  await Promise.all([
    deleteSeriesByIds(db, legacySeriesIds),
    deleteOccurrencesByIds(db, legacyOccurrenceIds),
    deleteOverridesByIds(db, legacyOverrideIds),
  ]);

  return {
    seriesRemoved: legacySeriesIds.length,
    occurrencesRemoved: legacyOccurrenceIds.length,
    overridesRemoved: legacyOverrideIds.length,
  };
}

/** cleanupDemoData の戻り値。全て 0 なら削除対象が無かった(冪等の2回目以降含む) */
export interface DemoDataCleanupResult {
  seriesRemoved: number;
  occurrencesRemoved: number;
  overridesRemoved: number;
}

/**
 * デモ/シードデータの一回きりクリーンアップ (実データ運用への移行、2026-07-20)。
 *
 * App.tsx の起動時シード (generateDummySeries/generateDummyOccurrences/
 * generateDummyOverrides) は開発時 (`import.meta.env.DEV` かつ `?demo=1`) の
 * みに退避したが、過去にシード済みだった環境には残骸が残るため、通常起動時に
 * 一度だけ掃除する。id 規則 (dummy.ts 参照): 単発ダミーは `dummy-<day>-<i>`、
 * シリーズは `series-<name>`。シリーズ由来の展開済み occurrence は
 * `${seriesId}:${originalStartMs}` 形式の id を持つため、id の前方一致ではなく
 * occurrence.seriesId がダミーシリーズ id 集合に含まれるかで判定する。
 *
 * 起動のたびに呼んでよい設計(冪等): 一度掃除し終われば以降は全て 0 件で
 * 即 return する。呼び出し側は 0 件なら何もログを出さない想定
 * (cleanupLegacyGoogleData と同じ流儀)。
 */
export async function cleanupDemoData(
  db: IDBPDatabase<KichijitsuDB>,
): Promise<DemoDataCleanupResult> {
  const [allSeries, allOccurrences, allOverrides] = await Promise.all([
    getAllSeries(db),
    getAllOccurrences(db),
    getAllOverrides(db),
  ]);

  const demoSeriesIds = allSeries.filter((s) => s.id.startsWith("series-")).map((s) => s.id);
  const demoSeriesIdSet = new Set(demoSeriesIds);
  const demoOccurrenceIds = allOccurrences
    .filter(
      (o) => o.id.startsWith("dummy-") || (o.seriesId !== null && demoSeriesIdSet.has(o.seriesId)),
    )
    .map((o) => o.id);
  const demoOverrideIds = allOverrides
    .filter((o) => demoSeriesIdSet.has(o.seriesId))
    .map((o) => o.id);

  if (
    demoSeriesIds.length === 0 &&
    demoOccurrenceIds.length === 0 &&
    demoOverrideIds.length === 0
  ) {
    return { seriesRemoved: 0, occurrencesRemoved: 0, overridesRemoved: 0 };
  }

  await Promise.all([
    deleteSeriesByIds(db, demoSeriesIds),
    deleteOccurrencesByIds(db, demoOccurrenceIds),
    deleteOverridesByIds(db, demoOverrideIds),
  ]);

  return {
    seriesRemoved: demoSeriesIds.length,
    occurrencesRemoved: demoOccurrenceIds.length,
    overridesRemoved: demoOverrideIds.length,
  };
}
