import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import type { IDBPDatabase } from "idb";
import type {
  AccountDTO,
  CalendarListEntryDTO,
  DisconnectRequest,
  MeResponse,
  SyncRequest,
  SyncResponse,
  TaskListDTO,
  TaskListsResponse,
  TasksSyncRequest,
  TasksSyncResponse,
  WatchRequest,
} from "@kichijitsu/shared";
import { hookActualByLinkedItem } from "./sync/hookActual";
import { resolveDefaultWriteTarget, type WriteTargetCandidate } from "./sync/eventCreate";
import { applyTasksSyncResponse, deleteTasksForAccount } from "./sync/applyTasksSync";
import {
  buildVisibleCalendarsRequest,
  mergeServerVisibleCalendarsWithPending,
  nextPendingVisiblePuts,
} from "./sync/visibleCalendars";
import { createSyncScheduler } from "./sync/syncScheduler";
import { buildSyncRequest } from "./sync/syncRequest";
import { deleteJson, getJson, jsonInit, sendJson } from "./sync/httpJson";
import { decideSyncBackfillTargets } from "./sync/syncBackfill";
import {
  DEFAULT_DECLINED_VISIBILITY,
  type DeclinedVisibilitySettings,
} from "./sync/declinedVisibility";
import { DEFAULT_HOUR_HEIGHT, normalizeHourHeight } from "./layout/gridMetrics";
import { WeekGrid } from "./components/WeekGrid";
import { HourHeightControl } from "./components/HourHeightControl";
import { MonthView } from "./components/MonthView";
import { LogoMark, LogoWordmark } from "./components/Logo";
import { MasuIndicator } from "./components/MasuIndicator";
import { BlockRulesOverlay } from "./components/BlockRulesOverlay";
import { SettingsModal } from "./components/SettingsModal";
import { MoveConfirmDialog } from "./components/MoveConfirmDialog";
import { CalendarPane } from "./components/CalendarPane";
import { KeyboardHelpOverlay } from "./components/KeyboardHelpOverlay";
import { SearchOverlay } from "./components/SearchOverlay";
import { GitHubPane } from "./components/GitHubPane";
import { RunningTimersIndicator } from "./components/RunningTimersIndicator";
import { TimeReportOverlay } from "./components/TimeReportOverlay";
import type { CalendarInfo } from "./components/EventBlock";
import { CalendarIcon, GearIcon, SearchIcon, TimerIcon } from "./components/icons";
import { useBlockRules } from "./hooks/useBlockRules";
import { useEventMutations } from "./hooks/useEventMutations";
import { useGitHubData, useGitHubPrCommitEstimates } from "./hooks/useGitHubData";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useMasuVisible } from "./hooks/useMasuVisible";
import { useMcpTokens } from "./hooks/useMcpTokens";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useOffline } from "./hooks/useOffline";
import { usePlannedBlockHandlers } from "./hooks/usePlannedBlockHandlers";
import { useServerEvents } from "./hooks/useServerEvents";
import { useTimelineNavigation } from "./hooks/useTimelineNavigation";
import { useTimers } from "./hooks/useTimers";
import { useWorkLogs } from "./hooks/useWorkLogs";
import {
  generateDummyOccurrences,
  generateDummyOverrides,
  generateDummySeries,
} from "./model/dummy";
import type { Occurrence } from "./model/types";
import { OccurrenceStore } from "./store/occurrenceStore";
import { AllDayStore } from "./store/allDayStore";
import { TaskStore } from "./store/taskStore";
import { GitHubStore } from "./store/githubStore";
import { PlannedStore, useAllPlannedBlocks } from "./store/plannedStore";
import { TimeEntryStore, useTimeEntries } from "./store/timeEntryStore";
import {
  CURRENT_SYNC_BACKFILL_VERSION,
  cleanupDemoData,
  cleanupLegacyGoogleData,
  countSeries,
  getAllAllDayOccurrences,
  getAllGitHubItems,
  getAllPlannedBlocks,
  getAllTasks,
  getDeclinedVisibilitySettings,
  getExpansionState,
  getHiddenTaskLists,
  getOccurrencesBetween,
  getOrCreateDeviceId,
  getSyncBackfillVersion,
  getVisibleCalendars,
  openKichijitsuDB,
  putOccurrences,
  putOverride,
  putSeries,
  setDeclinedVisibilitySettings,
  setHiddenTaskLists,
  setSyncBackfillVersion,
  setVisibleCalendars,
  type KichijitsuDB,
  type VisibleCalendarsMap,
} from "./db/database";
import { ensureExpanded } from "./expansion/ensureExpanded";
import { resolveJumpDate, type SearchJumpTarget } from "./search/searchOccurrences";
import { applySyncResponse, deleteGoogleData } from "./sync/applySync";
import { monthGridRangeMs } from "./layout/monthGrid";
import {
  effectivePaneMode,
  isPaneMode,
  shouldCloseOtherPaneOnOpen,
  type PaneMode,
} from "./layout/paneMode";
import { addToSet, removeFromSet } from "./layout/setOps";
import { calendarKey, taskListKey } from "./layout/keys";
import { readStored, writeStored } from "./layout/localStore";
import { timelineRangeMs } from "./layout/viewRange";
import "./App.css";

/**
 * モバイル対応フェーズ2(docs/multiplatform.md): 週ビュー('week')に加えて、狭幅向けの
 * N日タイムライン(day3=3日、day1=1日)がある。'month' は従来通り別レイアウト。
 *
 * view / timelineStart / monthCursor とその移動操作(←/→/今日・ビュー切替・ミニ月カレンダー・
 * スワイプ)、および view の localStorage 永続化は hooks/useTimelineNavigation.ts へ移した
 * (リファクタリング フェーズ2 ①、2026-07-25)。View 型・view から表示範囲を導く純関数の
 * 置き場所についてはそちらのコメントを参照。App.tsx はフックの返り値を各コンポーネントへ
 * 配線し、表示範囲(timelineRangeMs)で fetch を回すだけになっている。
 */

/** 同期対象の (accountId, taskListId) ペア(docs/google-tasks.md)。selectedTargets のタスク版 */
interface TaskListTarget {
  accountId: string;
  taskListId: string;
}

/**
 * 時間軸ズーム(2026-07-25、ユーザー要望)。1時間あたりの px 高さをこの端末のローカル設定として
 * 覚える。保存するのは「プリセット名」ではなく実際の px 値(ユーザー決定) ―― −/+ の 8px 刻みや
 * ⌘/Ctrl+ホイールでプリセットから外れた値も、そのまま次回に復元できるようにするため。
 * 読み込み時の範囲外/不正値は既定 48 に丸める(layout/gridMetrics.ts の normalizeHourHeight)。
 */
const HOUR_HEIGHT_STORAGE_KEY = "kichijitsu:hourHeight";

/** localStorage に保存された前回のズーム値(px)。未保存/不正/プライベートモード等なら既定値 */
function loadStoredHourHeight(): number {
  // normalizeHourHeight は範囲外/不正値も既定へ丸める(null を返さない)ので、
  // fallback が効くのは「未保存」と「localStorage が使えない」のときだけ
  return readStored(HOUR_HEIGHT_STORAGE_KEY, normalizeHourHeight, DEFAULT_HOUR_HEIGHT);
}

const PANE_MODE_STORAGE_KEY = "kichijitsu:paneMode";

/** localStorage に保存された前回選択の GitHub ペイン配置モードを読む。プライベートモード等で無効なら null */
function loadStoredPaneMode(): PaneMode | null {
  return readStored<PaneMode | null>(
    PANE_MODE_STORAGE_KEY,
    (v) => (isPaneMode(v) ? v : null),
    null,
  );
}

/**
 * 左ペイン「カレンダー」(CalendarPane、カレンダーナビゲーション増分1、2026-07-22)の
 * 開閉状態。GitHubPane 側の開閉(paneOpen)は永続化していないが、左ペインはカレンダー選択
 * という主要ナビゲーションを担うため、開閉状態自体は次回訪問時に復元する(要件どおり)。
 *
 * 配置モード(kichijitsu:leftPaneMode)は「ヘッダー整理+左ペイン常設化」(増分3、2026-07-22)で
 * オーバーレイ方式を廃止したことにより不要になった ―― 左ペインは開いている間は常に docked
 * 固定(layout/paneMode.ts のコメント、CalendarPane.tsx のコメント参照)。旧バージョンで
 * localStorage に書き込まれた kichijitsu:leftPaneMode の値は読み捨てる(積極的に削除は
 * しないが、もう読み書きしないため実質無視される)。
 */
const LEFT_PANE_OPEN_STORAGE_KEY = "kichijitsu:leftPaneOpen";

/**
 * localStorage に保存された前回の左ペイン開閉状態を読む。プライベートモード等で無効・未保存なら
 * null(呼び出し側で「初回は開いた状態を既定にする」フォールバックを行う想定)。
 */
function loadStoredLeftPaneOpen(): boolean | null {
  return readStored<boolean | null>(
    LEFT_PANE_OPEN_STORAGE_KEY,
    (v) => (v === "1" ? true : v === "0" ? false : null),
    null,
  );
}

/**
 * デモ/シードデータの自動投入を許可するかどうか (2026-07-20、実データ運用への移行)。
 * 通常起動では常に false — 実データ (Google 連携) だけを表示する。
 * ローカル開発で UI を素早く確認したいときだけ、`import.meta.env.DEV` (本番ビルドでは
 * 常に false に固定される) かつ URL に `?demo=1` を付けた場合のみダミーの週間データを
 * シードする退避経路として残してある。
 */
const DEMO_SEED_ENABLED =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("demo") === "1";

function App() {
  const timeZone = useMemo(() => Temporal.Now.timeZoneId(), []);
  // モバイル対応フェーズ2: 狭幅(~640px 未満)かどうか。既定 view の選択(useTimelineNavigation)と
  // ツールバーのビュー切替ボタン構成(1日/3日/月 ⇔ 週/月)の両方に使う
  const isNarrow = useMediaQuery("(max-width: 640px)");
  /**
   * 「今どの期間を見ているか」と移動操作(hooks/useTimelineNavigation.ts)。外部 I/O を持たない
   * 閉じた塊なので、App.tsx はここでは値を受け取って配線するだけ。
   * 返り値は JSX/effect 側の既存の名前(handleNavigateToDay 等)に別名で受けて、呼び出し箇所を
   * 一切変えずに済ませている。
   */
  const {
    view,
    timelineStart,
    monthCursor,
    dayCount,
    goToPrev,
    goToNext,
    goToToday,
    switchView,
    navigateToDay: handleNavigateToDay,
    miniMonthNavigate: handleMiniMonthNavigate,
    swipeNavigate: handleSwipeNavigate,
    goToTodayForNewEvent,
  } = useTimelineNavigation({ isNarrow });
  // 時間軸ズーム(2026-07-25): 1時間あたりの px。view/timelineStart と同じくここが唯一の
  // 出どころで、WeekGrid(CSS 変数 --hour-height + 日列配下への context)とツールバーの
  // HourHeightControl が同じ state を共有する。MonthView は時間軸を持たないので無関係。
  const [hourHeight, setHourHeight] = useState<number>(loadStoredHourHeight);

  // 時間軸ズームの永続化(view と同じ流儀。保存するのは実 px 値)
  useEffect(() => {
    writeStored(HOUR_HEIGHT_STORAGE_KEY, String(hourHeight));
  }, [hourHeight]);

  // WeekGrid の ⌘/Ctrl+ホイールズームから呼ばれる。値の clamp は呼び出し側(WeekGrid /
  // HourHeightControl)で済んでいるが、ここでも normalize を通して不正値が state に入らないようにする
  const handleHourHeightChange = useCallback((next: number) => {
    setHourHeight(normalizeHourHeight(next));
  }, []);

  // GitHub 情報ペイン(GitHubPane、増分1)の配置モード(overlay/docked)。view と同じく
  // ユーザーの明示的な選択を覚えておき、次回訪問時のデフォルトにする。isNarrow による
  // docked 不可のフォールバックは resolvedPaneMode(effectivePaneMode)側で行い、この state
  // 自体は狭幅表示中でも書き換えない(layout/paneMode.ts のコメント参照)
  const [paneMode, setPaneMode] = useState<PaneMode>(() => loadStoredPaneMode() ?? "overlay");

  useEffect(() => {
    writeStored(PANE_MODE_STORAGE_KEY, paneMode);
  }, [paneMode]);

  // 狭幅では docked を選べない(effectivePaneMode 参照)ので、実際に GitHubPane へ渡すモードは
  // 常にこちらを使う。paneMode(永続化される好み)自体は isNarrow に関わらず変更しない
  const resolvedPaneMode = effectivePaneMode(paneMode, isNarrow);

  // 左ペインの開閉。カレンダー選択という主要ナビゲーションを担うため、GitHubPane の paneOpen
  // (永続化しない、増分1では未連携時に隠れる補助ペイン)とは違い開閉状態自体を永続化する。
  // 初回訪問(未保存)は開いた状態を既定にする(新機能の発見性を優先)
  const [leftPaneOpen, setLeftPaneOpen] = useState(() => loadStoredLeftPaneOpen() ?? true);

  useEffect(() => {
    writeStored(LEFT_PANE_OPEN_STORAGE_KEY, leftPaneOpen ? "1" : "0");
  }, [leftPaneOpen]);

  const store = useMemo(() => new OccurrenceStore(), []);
  const allDayStore = useMemo(() => new AllDayStore(), []);
  // Google タスク (docs/google-tasks.md) の読み口。AllDayStore と対になる別ストア
  const taskStore = useMemo(() => new TaskStore(), []);
  // GitHub 連携 (docs/github-integration.md フェーズ①Part B) の読み口。未連携時も
  // インスタンス自体は常に存在し、単に空のまま(WeekGrid 側がレーンを非表示にする)
  const githubStore = useMemo(() => new GitHubStore(), []);
  // 予定タイムブロック(docs/github-integration.md「時間計測」増分1)の読み口。occurrences とは
  // 完全に独立したストア — Google 同期(applySync 等)はこのストアに一切触れない
  const plannedStore = useMemo(() => new PlannedStore(), []);
  // 手動タイマー・実績記録(docs/github-integration.md「時間計測」増分2)の読み口。plannedStore と
  // 同じく Google 同期からは完全に独立し、ローカル操作のみで更新される
  const timeEntryStore = useMemo(() => new TimeEntryStore(), []);
  const [db, setDb] = useState<IDBPDatabase<KichijitsuDB> | null>(null);

  // マルチアカウント対応 (2026-07-19): me.accounts[] を回って各アカウントの
  // カレンダー一覧を取得し、選択中カレンダー(IndexedDB meta に永続化)ごとに同期する。
  const [me, setMe] = useState<MeResponse>({
    connected: false,
    accounts: [],
    visibleCalendars: {},
    github: null,
  });
  const [calendarsByAccount, setCalendarsByAccount] = useState<
    Record<string, CalendarListEntryDTO[]>
  >({});
  const [visibleCalendars, setVisibleCalendarsState] = useState<VisibleCalendarsMap>({});
  // アカウントごとのタスクリスト一覧(docs/google-tasks.md)。tasks スコープ未付与(403)の
  // アカウントはエントリが付かないまま = タスク機能オフとして扱う。同期対象
  // (selectedTaskListTargets)は常にここの全件 ―― 表示 ON/OFF (hiddenTaskLists、下)とは
  // 独立していて、非表示にしても同期は止めない(左ペイン増分2、db/database.ts の
  // getHiddenTaskLists コメント参照)
  const [taskListsByAccount, setTaskListsByAccount] = useState<Record<string, TaskListDTO[]>>({});
  // tasks スコープ未付与のアカウント id 集合(docs/google-tasks.md、2026-07-20 追加の
  // .../auth/tasks スコープより前に連携した、または granular consent で外したアカウント)。
  // GET /api/tasklists が 403 を返したアカウントをここに覚えておき、設定モーダルで
  // 「再連携」導線を出す(そのまま静かにスキップするだけだとタスクが無言で消え、原因に
  // 気づけないため)。200 で取れたアカウントは外す ―― 再連携でスコープを得たら消える。
  const [tasksScopeMissingAccounts, setTasksScopeMissingAccounts] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // タスクリスト表示 ON/OFF(左ペイン増分2、2026-07-22)。visibleCalendars とは逆に
  // 「明示的に非表示にした `${accountId}:${taskListId}` の集合」を持つ(デフォルト全 ON、
  // db/database.ts の getHiddenTaskLists 参照)。カレンダー選択と非対称にサーバー同期は
  // 行わずこの端末のみのローカル設定(将来 PUT /api/visible-task-lists 相当を足す余地はある)
  // ReadonlySet で持つのは layout/setOps.ts の addToSet/removeFromSet(変化が無ければ同じ参照を
  // 返す)をそのまま setState に渡せるようにするため。読み手(CalendarPane/WeekGrid)は has だけ使う
  const [hiddenTaskLists, setHiddenTaskListsState] = useState<ReadonlySet<string>>(new Set());
  // 上の hiddenTaskLists 永続化 effect が、init effect の IndexedDB 読み込み完了前に
  // 空集合で上書きしてしまわないためのガード(visibleCalendarsLoadedRef と同じ役割)
  const hiddenTaskListsLoadedRef = useRef(false);
  // 「不参加を表示」設定(参加ステータス表示、2026-07-22)。左ペイン(CalendarPane)の
  // 「表示」セクションで ON/OFF する。hiddenTaskLists と同じ流儀 ―― この端末のみの
  // ローカル設定で、サーバー同期はしない(db/database.ts の getDeclinedVisibilitySettings 参照)
  const [declinedVisibility, setDeclinedVisibilityState] = useState<DeclinedVisibilitySettings>(
    DEFAULT_DECLINED_VISIBILITY,
  );
  // 上の declinedVisibility 永続化 effect が、init effect の IndexedDB 読み込み完了前に
  // 既定値で上書きしてしまわないためのガード(hiddenTaskListsLoadedRef と同じ役割)
  const declinedVisibilityLoadedRef = useRef(false);
  const [panelOpen, setPanelOpen] = useState(false);
  // '?' キーでトグルするキーボードショートカット ヘルプオーバーレイ(フェーズ6)
  const [helpOpen, setHelpOpen] = useState(false);
  // 予定検索オーバーレイ(フェーズ6)の開閉。ツールバーの検索ボタンからのみ開く
  // (キーボードショートカット化は別途 keyboard/shortcuts.ts 側の対応が必要なため今回は配線しない)
  const [searchOpen, setSearchOpen] = useState(false);
  // カレンダーブロック設定 (docs/blocking.md、フェーズ7 第1段階の UI 部分) の開閉。
  // ルール一覧そのものは hooks/useBlockRules.ts が持つ(下の useBlockRules 呼び出し)
  const [blockOverlayOpen, setBlockOverlayOpen] = useState(false);
  // GitHub 情報ペイン(GitHubPane、増分1で WorkQueueDrawer から発展)の開閉。増分1では
  // セクションが作業キュー1つだけのため実質「作業キューが見えているか」と同義だが、
  // 名称はペイン全体のクロム(開閉・配置モード)を指すものとして paneOpen にしてある。
  // GitHub 由来のデータ側の state(githubAuthExpired・githubQueue・queueLoading・
  // queueAuthExpired・実績/CI オーバーレイ・commit 推定)と取得 effect は
  // hooks/useGitHubData.ts へ移した(リファクタリング フェーズ2 ③、2026-07-25)ので、
  // ここに残るのは UI クロムの開閉だけ
  const [paneOpen, setPaneOpen] = useState(false);
  // 予定 vs 実績レポート (docs/github-integration.md「時間計測」増分2)。開閉のみの状態、
  // データは plannedStore/timeEntryStore から都度読む(専用 state は持たない)
  const [reportOpen, setReportOpen] = useState(false);
  // 実績(記録/タイマー/履歴)は 2026-07-25 に専用モーダル(WorkLogModal)を廃して右ペイン
  // (GitHubPane)へ集約した。開閉は右ペインの paneOpen が兼ねるため専用 state は持たない
  // ―― データは reportWorkLogs/reportPlannedBlocks をそのままペインへ渡す。
  // hook 実績 (work_logs) の一覧 state と取得/作成/更新/削除は hooks/useWorkLogs.ts へ移した
  // (リファクタリング フェーズ2 ⑤、2026-07-25。下の useWorkLogs 呼び出し参照)
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "error">("idle");
  // 保存失敗のフラッシュ表示 (saveError) と移動確認ダイアログ (moveConfirm) の state は、
  // それを立てる変更系ハンドラごと hooks/useEventMutations.ts へ移した
  // (リファクタリング フェーズ2 ④、2026-07-25。下の useEventMutations 呼び出し参照)
  const autoSyncedRef = useRef(false);
  // 「このアカウントのカレンダー一覧は初回フェッチ済み/フェッチ中」フラグ。
  // me.accounts effect が同じアカウントに何度も初回フェッチを走らせないためのもの。
  // 取得失敗したアカウントの再フェッチ(リトライ)はこれとは別に calendarsByAccount の
  // 有無で判定する(下の panelOpen effect 参照)
  const fetchedAccountsRef = useRef(new Set<string>());
  // 同一アカウントへの並行フェッチ防止(初回フェッチとパネルオープン時のリトライが
  // 同時に走るケースがあるため)
  const fetchInFlightRef = useRef(new Set<string>());
  // 「このアカウントのタスクリスト一覧は初回フェッチ済み/フェッチ中」フラグ(fetchedAccountsRef のタスク版)
  const fetchedTaskAccountsRef = useRef(new Set<string>());
  // 新規に見つかった (accountId, taskListId) を一度だけ自動同期するための既知集合
  // (`${accountId}:${taskListId}` キー、runSync の手動同期とは別に初回表示を早める用途)
  const autoSyncedTaskListsRef = useRef(new Set<string>());
  // getVisibleCalendars(db) での初回ロードが終わるまでは、下の永続化 effect を
  // 発火させない({} で上書きしてしまわないためのガード)
  const visibleCalendarsLoadedRef = useRef(false);
  // PUT /api/visible-calendars の lost update 防止 (2026-07-21)。オフライン中/失敗時に
  // その accountId の最新 calendarIds を記録しておき、checkMe (起動時・online 復帰時) の
  // 先頭で再送してから /api/me をマージする(sync/visibleCalendars.ts 参照)
  const pendingVisiblePutsRef = useRef<Map<string, string[]>>(new Map());
  // syncCalendar (増分同期・全同期) の同一 (accountId, calendarId) 多重実行ガード (2026-07-21)。
  // SSE hello/changed・起動時 runSync・カレンダー選択トグルなど複数経路から await なしで
  // 多重に発火しうるため、キー単位で直列化する (sync/syncScheduler.ts 参照)
  const syncSchedulerRef = useRef(createSyncScheduler());
  // 端末ごと syncToken (2026-07-21): この端末の deviceId (IndexedDB meta に永続化、
  // db/database.ts の getOrCreateDeviceId 参照)。init effect で db を開いた直後に取得して
  // ここへ入れる。POST /api/sync の body に含めることで、サーバー (UserSyncDO) が
  // (calendar_id, device_id) 単位で syncToken を管理できるようにする — 端末Aの同期が
  // 進めたトークンで端末Bが差分を取りこぼす設計欠陥の修正 (sync/syncRequest.ts 参照)。
  // 理論上 db より先に syncCalendarOnce が走ることは無いが、念のため null 許容にしてあり、
  // null のままなら (旧クライアントと同じ) レガシー共有トークン動作にフォールバックする
  const deviceIdRef = useRef<string | null>(null);
  // fetchCalendarsFor がデフォルト選択(primary)を初適用したかどうかを同期的に判定するための
  // 直近の visibleCalendars スナップショット(POST /api/watch の登録要否判定に使う。
  // レンダーごとに更新するだけで、これ自体は再レンダーを起こさない)
  const visibleCalendarsRef = useRef<VisibleCalendarsMap>({});
  visibleCalendarsRef.current = visibleCalendars;

  // オフライン表示(brand/README.md「枡オーナメント」節: 空枡+「オフライン」)。
  // fetch 経路は checkedFetch を薄く差し込んで判定する(useOffline.ts 参照)
  const { offline, markOffline, markOnline } = useOffline();
  const checkedFetch = useCallback(
    async (input: string, init?: RequestInit): Promise<Response> => {
      let res: Response;
      try {
        res = await fetch(input, init);
      } catch (err) {
        markOffline();
        throw err;
      }
      // vite の dev proxy はバックエンド不在時に 502 を返す(App.tsx の他の箇所と同じ想定)。
      // それ以外の応答は「サーバーに届いている」ことの証跡として online 扱いにする
      if (res.status === 502) {
        markOffline();
      } else {
        markOnline();
      }
      return res;
    },
    [markOffline, markOnline],
  );

  // POST /api/watch — 選択中カレンダーの push 通知登録/解除。fire-and-forget
  // (登録は best-effort。失敗してもアラームポーリングが補うので UI はブロックしない)
  const postWatch = useCallback(
    (accountId: string, calendarId: string, enabled: boolean) => {
      checkedFetch(
        "/api/watch",
        jsonInit("POST", { accountId, calendarId, enabled } satisfies WatchRequest),
      )
        .then((res) => {
          if (!res.ok) {
            console.warn(
              `kichijitsu: POST /api/watch failed (${accountId}/${calendarId}): ${res.status}`,
            );
          }
        })
        .catch((err) => {
          console.warn("kichijitsu: POST /api/watch failed", err);
        });
    },
    [checkedFetch],
  );

  // PUT /api/visible-calendars — カレンダー選択をサーバーに保存する (端末間同期、2026-07-20)。
  // 失敗(fetch 例外・非2xx)したら pendingVisiblePutsRef に記録し、checkMe が online 復帰時に
  // 再送する(lost update 防止、2026-07-21。sync/visibleCalendars.ts の nextPendingVisiblePuts
  // 参照)。成否を呼び出し側が判定できるよう boolean を返す
  const putVisibleCalendarsOnce = useCallback(
    async (accountId: string, calendarIds: string[]): Promise<boolean> => {
      let ok: boolean;
      try {
        const res = await checkedFetch(
          "/api/visible-calendars",
          jsonInit("PUT", buildVisibleCalendarsRequest(accountId, calendarIds)),
        );
        ok = res.ok;
        if (!ok) {
          console.warn(
            `kichijitsu: PUT /api/visible-calendars failed (${accountId}): ${res.status}`,
          );
        }
      } catch (err) {
        ok = false;
        console.warn("kichijitsu: PUT /api/visible-calendars failed", err);
      }
      pendingVisiblePutsRef.current = nextPendingVisiblePuts(
        pendingVisiblePutsRef.current,
        accountId,
        calendarIds,
        ok ? "success" : "failure",
      );
      return ok;
    },
    [checkedFetch],
  );

  // handleToggleCalendar のトグル時と、fetchCalendarsFor の初回 primary デフォルト選択時に
  // 呼ぶ fire-and-forget 版: UI/IndexedDB は既に楽観的更新済みなので、失敗してもロールバックしない
  // (選択はローカルに残るため動作は継続でき、オフライン表示は checkedFetch の markOffline に委ねる。
  // 失敗の追跡は putVisibleCalendarsOnce 内の pendingVisiblePutsRef が担う)
  const putVisibleCalendars = useCallback(
    (accountId: string, calendarIds: string[]) => {
      void putVisibleCalendarsOnce(accountId, calendarIds);
    },
    [putVisibleCalendarsOnce],
  );

  // 初回ロード中(db==null, store に最初のデータがまだ入っていない)かどうか。
  // グリッド中央に枡インジケーターをオーバーレイし、初期化完了で消す
  const initializing = db === null;
  const initIndicator = useMasuVisible(initializing);
  const syncIndicator = useMasuVisible(syncStatus === "syncing");

  // 起動時: DB を開く → 初回のみ dummy データをシード → 表示週ぶんを展開 →
  // 展開済み範囲全体(単発イベント込み)を store に反映する → 選択中カレンダーを読み込む
  useEffect(() => {
    let cancelled = false;

    async function init() {
      const database = await openKichijitsuDB();
      if (cancelled) return;

      // 端末ごと syncToken (2026-07-21): db を開いた直後に deviceId を取得/生成しておく。
      // 以後の syncCalendarOnce (POST /api/sync) がこれを body に含める
      const deviceId = await getOrCreateDeviceId(database);
      if (cancelled) return;
      deviceIdRef.current = deviceId;

      // レガシー掃除(一回きり・冪等): ID スコープ化 (2026-07-19) 以前の旧形式
      // Google データ (`g:<eventId>`、accountId/calendarId フィールドなし) は
      // 現行のフィルタにマッチしない不可視の残骸なので削除する。0件なら何も出さない
      const legacyCleanup = await cleanupLegacyGoogleData(database);
      if (cancelled) return;
      const legacyTotal =
        legacyCleanup.seriesRemoved +
        legacyCleanup.occurrencesRemoved +
        legacyCleanup.overridesRemoved;
      if (legacyTotal > 0) {
        console.info(
          `kichijitsu: legacy Google data cleanup removed ${legacyTotal} record(s) ` +
            `(series=${legacyCleanup.seriesRemoved}, occurrences=${legacyCleanup.occurrencesRemoved}, ` +
            `overrides=${legacyCleanup.overridesRemoved})`,
        );
      }

      // デモ/シードデータの一回きりクリーンアップ (実データ運用への移行、2026-07-20):
      // DEMO_SEED_ENABLED が false の通常起動では二度とシードされないが、過去に
      // シード済みだった環境の残骸を掃除する。cleanupLegacyGoogleData と同じ流儀で
      // 起動のたびに呼んでよい(冪等・0件なら何も出さない)
      const demoCleanup = await cleanupDemoData(database);
      if (cancelled) return;
      const demoTotal =
        demoCleanup.seriesRemoved + demoCleanup.occurrencesRemoved + demoCleanup.overridesRemoved;
      if (demoTotal > 0) {
        console.info(
          `kichijitsu: demo data cleanup removed ${demoTotal} record(s) ` +
            `(series=${demoCleanup.seriesRemoved}, occurrences=${demoCleanup.occurrencesRemoved}, ` +
            `overrides=${demoCleanup.overridesRemoved})`,
        );
      }

      // ダミーシード投入は開発時の明示的なオプトイン (?demo=1) のときだけ (DEMO_SEED_ENABLED 参照)。
      // 実データ運用では絶対に自動投入しない
      if (DEMO_SEED_ENABLED) {
        const existingSeriesCount = await countSeries(database);
        if (existingSeriesCount === 0) {
          const series = generateDummySeries(timeZone);
          const overrides = generateDummyOverrides(series);
          const singles = generateDummyOccurrences(Temporal.Now.plainDateISO(), timeZone);
          await putSeries(database, series);
          await Promise.all(overrides.map((o) => putOverride(database, o)));
          await putOccurrences(database, singles);
        }
      }
      if (cancelled) return;

      const initialRange =
        view === "month"
          ? monthGridRangeMs(monthCursor, timeZone)
          : timelineRangeMs(timelineStart, dayCount, timeZone);
      await ensureExpanded(database, store, initialRange.fromMs, initialRange.toMs);
      if (cancelled) return;

      const state = await getExpansionState(database);
      let all: Occurrence[] | undefined;
      if (state) {
        all = await getOccurrencesBetween(database, state.expandedFromMs, state.expandedToMs);
      }

      // 終日予定 (フェーズ5): 展開ウィンドウの概念が無いため全件を丸ごとロードする
      const allDays = await getAllAllDayOccurrences(database);
      // Google タスク (docs/google-tasks.md): 終日予定と同じく全件を丸ごとロードする
      const allTasks = await getAllTasks(database);
      // GitHub アイテム (docs/github-integration.md フェーズ①Part B): 同じく全件ロード。
      // ここでは前回取得のキャッシュを表示するだけで、最新化は me.github 判明後の別 effect が行う
      const allGitHubItems = await getAllGitHubItems(database);
      // 予定タイムブロック (docs/github-integration.md「時間計測」増分1): 同じく全件ロード。
      // Google 同期とは無関係なので、以後この値がサーバーから再取得されることは無い
      // (ローカル操作のみで更新される)
      const allPlannedBlocks = await getAllPlannedBlocks(database);
      // 手動タイマーの走行中状態は実績 UX 刷新フェーズ5b(2026-07-23)でサーバー開区間
      // (GET /api/work-logs/open)を単一の真実にしたため、ここで IndexedDB から TimeEntry を
      // 読み込むことはしない(timeEntryStore は開区間の射影キャッシュとして下の effect が満たす)。

      // occurrences・終日予定・タスク・GitHub アイテム・予定タイムブロックの
      // 初回反映を1回の通知にまとめ、初期描画のチラつきを防ぐ
      if (!cancelled) {
        await store.batch(async () => {
          await allDayStore.batch(async () => {
            await taskStore.batch(async () => {
              await githubStore.batch(async () => {
                await plannedStore.batch(async () => {
                  if (all) store.load(all);
                  allDayStore.load(allDays);
                  taskStore.load(allTasks);
                  githubStore.load(allGitHubItems);
                  plannedStore.load(allPlannedBlocks);
                });
              });
            });
          });
        });
      }

      const storedVisible = await getVisibleCalendars(database);
      if (!cancelled) {
        // ここで単純に setVisibleCalendarsState(storedVisible) すると、下の
        // 「me.accounts が増えるたびにカレンダー一覧を取得する」effect が
        // (/api/me・/api/calendars は同一プロセス内の高速な往復のため) この
        // DB 読み込みより先に primary デフォルト選択を書き込んでいた場合、
        // それを空の storedVisible で握り潰してしまう(= 一生 primary が
        // 選ばれないまま {} が永続化される既知のバグだった)。
        // 既に state にある値(prev)を優先してマージすることで、どちらが
        // 先に解決してもデフォルト選択が失われないようにする
        setVisibleCalendarsState((prev) => ({ ...storedVisible, ...prev }));
        visibleCalendarsLoadedRef.current = true;
      }

      // タスクリスト表示 ON/OFF(左ペイン増分2): サーバー同期が無くこの端末の IndexedDB が
      // 唯一の正なので、visibleCalendars のような server/prev マージは不要 ―― 素直に読み込むだけ
      const storedHiddenTaskLists = await getHiddenTaskLists(database);
      if (!cancelled) {
        setHiddenTaskListsState(storedHiddenTaskLists);
        hiddenTaskListsLoadedRef.current = true;
      }

      // 「不参加を表示」設定(参加ステータス表示): hiddenTaskLists と同じくこの端末の
      // IndexedDB が唯一の正なので、素直に読み込むだけでよい
      const storedDeclinedVisibility = await getDeclinedVisibilitySettings(database);
      if (!cancelled) {
        setDeclinedVisibilityState(storedDeclinedVisibility);
        declinedVisibilityLoadedRef.current = true;
      }

      if (!cancelled) setDb(database);
    }

    init().catch((err) => {
      console.error("kichijitsu: initialization failed", err);
    });

    return () => {
      cancelled = true;
    };
    // 初回マウント時にのみ実行する。timelineStart/view はマウント時点の値で固定してよい
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // タイムライン/月ナビゲーション時: 表示範囲(view に応じて N日タイムライン or 6週グリッド全体)を
  // 賄うのに十分な展開が済んでいるか確認する
  useEffect(() => {
    if (!db) return;
    const { fromMs, toMs } =
      view === "month"
        ? monthGridRangeMs(monthCursor, timeZone)
        : timelineRangeMs(timelineStart, dayCount, timeZone);
    ensureExpanded(db, store, fromMs, toMs).catch((err) => {
      console.error("kichijitsu: ensureExpanded failed", err);
    });
  }, [db, view, timelineStart, dayCount, monthCursor, timeZone, store]);

  // Google 連携状態を確認する。バックエンド (apps/sync) が起動していない場合の
  // fetch 失敗 / 非 2xx は「未接続」として静かに扱う(コンソールを汚さない)。
  // 起動時に1回、加えてブラウザの online イベントでも再確認する(オフライン復帰時)
  const checkMe = useCallback(async () => {
    // /api/me を取得する前に、オフライン中/失敗で溜まった pending な PUT
    // /api/visible-calendars を先に再送する(lost update 防止、2026-07-21)。
    // ここで直近のローカル選択をサーバーに反映してから「サーバー勝ち」マージに
    // 入らないと、オフライン中に変えた選択が古いサーバー値に潰されてしまう
    const pendingEntries = [...pendingVisiblePutsRef.current.entries()];
    if (pendingEntries.length > 0) {
      await Promise.all(
        pendingEntries.map(([accountId, calendarIds]) =>
          putVisibleCalendarsOnce(accountId, calendarIds),
        ),
      );
    }

    try {
      const res = await checkedFetch("/api/me");
      if (!res.ok) {
        setMe({ connected: false, accounts: [], visibleCalendars: {}, github: null });
        return;
      }
      const data = (await res.json()) as MeResponse;
      setMe(data);
      // サーバーに configured なエントリを取り込む(サーバーが正)。無いアカウントは
      // ローカルの値(IndexedDB キャッシュ・初回 primary デフォルト選択)をそのまま残す。
      // 再送してもなお失敗が残っている accountId(pendingVisiblePutsRef に残存)は、
      // サーバー勝ちマージのあとでローカル値に復元する(mergeServerVisibleCalendarsWithPending
      // 参照。init effect の IndexedDB ロードとの解決順序に依存しない — どちらが先でも
      // 既存のレース対策(prev 優先マージ)と両立する)
      const stillPending = [...pendingVisiblePutsRef.current.keys()];
      setVisibleCalendarsState((prev) =>
        mergeServerVisibleCalendarsWithPending(prev, data.visibleCalendars, stillPending),
      );
    } catch {
      setMe({ connected: false, accounts: [], visibleCalendars: {}, github: null });
    }
  }, [checkedFetch, putVisibleCalendarsOnce]);

  useEffect(() => {
    checkMe();
  }, [checkMe]);

  useEffect(() => {
    function onOnline() {
      checkMe();
    }
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [checkMe]);

  // カレンダーブロックのルール一覧 + 作成/削除(hooks/useBlockRules.ts)。取得タイミング
  // (me.connected になったら一度だけ)も含めてフック側にあるので、ここは配線だけ。
  // 返り値は JSX 側の既存の名前に別名で受けて、呼び出し箇所を変えずに済ませている
  const {
    blockRules,
    createBlockRule: handleCreateBlockRule,
    deleteBlockRule: handleDeleteBlockRule,
  } = useBlockRules({ connected: me.connected, checkedFetch });

  // GitHub 連携 (docs/github-integration.md) のデータ取得は hooks/useGitHubData.ts へ移した
  // (リファクタリング フェーズ2 ③、2026-07-25)。アイテムレーン(①)・実績オーバーレイ(③)・
  // CI/Actions 実行(④b)・作業キュー(②)・右ペインの repo/issue プルダウンが対象で、
  // 取得タイミング・300ms デバウンス・isTauri() のプロバイダ分岐・401/409/502 の扱いは
  // すべてフック側にある。ここは配線だけ。
  // 呼び出し位置は移設前の各 effect の登録順(items → activity → ci → queue)をそのまま
  // 保つためここに置いてある(依存配列はレンダー中に評価されるので、後段で計算する値には
  // 触れられない ―― commit 推定だけ別フックに分けているのはそれが理由。下の
  // useGitHubPrCommitEstimates 参照)。返り値は JSX/呼び出し側の既存の名前に別名で受けて、
  // 呼び出し箇所を一切変えずに済ませている
  const {
    githubAuthExpired,
    setGithubAuthExpired,
    githubQueue,
    queueLoading,
    queueAuthExpired,
    fetchGithubQueue,
    githubActivity,
    activityVisible,
    toggleActivityVisible: handleToggleActivityVisible,
    githubCiRuns,
    ciVisible,
    toggleCiVisible: handleToggleCiVisible,
    fetchReposForPane,
    fetchRepoIssuesForPane,
    clearGitHubData,
  } = useGitHubData({
    db,
    github: me.github,
    githubStore,
    paneOpen,
    view,
    timelineStart,
    dayCount,
    timeZone,
    checkedFetch,
  });

  // visibleCalendars が変わるたびに IndexedDB meta へ永続化する。
  // 初回ロード(上の init effect)が完了するまでは待つ({} での上書きを防ぐ)
  useEffect(() => {
    if (!db || !visibleCalendarsLoadedRef.current) return;
    setVisibleCalendars(db, visibleCalendars).catch((err) => {
      console.error("kichijitsu: failed to persist visibleCalendars", err);
    });
  }, [db, visibleCalendars]);

  // hiddenTaskLists(左ペイン増分2)が変わるたびに IndexedDB meta へ永続化する。
  // visibleCalendars の永続化 effect と同じ流儀(初回ロード完了までは待つ)
  useEffect(() => {
    if (!db || !hiddenTaskListsLoadedRef.current) return;
    setHiddenTaskLists(db, hiddenTaskLists).catch((err) => {
      console.error("kichijitsu: failed to persist hiddenTaskLists", err);
    });
  }, [db, hiddenTaskLists]);

  // declinedVisibility(参加ステータス表示)が変わるたびに IndexedDB meta へ永続化する。
  // hiddenTaskLists の永続化 effect と同じ流儀(初回ロード完了までは待つ)
  useEffect(() => {
    if (!db || !declinedVisibilityLoadedRef.current) return;
    setDeclinedVisibilitySettings(db, declinedVisibility).catch((err) => {
      console.error("kichijitsu: failed to persist declinedVisibility", err);
    });
  }, [db, declinedVisibility]);

  // アカウント一覧ぶんのカレンダー一覧を取得し、state に反映する共通処理。
  // 「me.accounts が増えたときの初回フェッチ」と「設定パネルを開いたときの
  // 未取得/取得失敗アカウントのリトライ」の両方から使う。
  // 初回連携時(=このアカウントの visibleCalendars が未設定)はデフォルトで primary のみ選択する
  const fetchCalendarsFor = useCallback(
    async (accounts: AccountDTO[], isCancelled: () => boolean) => {
      for (const account of accounts) {
        if (fetchInFlightRef.current.has(account.id)) continue; // 並行フェッチ防止
        fetchInFlightRef.current.add(account.id);
        try {
          const calendars = await getJson<CalendarListEntryDTO[]>(
            checkedFetch,
            `/api/calendars?accountId=${encodeURIComponent(account.id)}`,
          );
          if (isCancelled()) return;
          setCalendarsByAccount((prev) => ({ ...prev, [account.id]: calendars }));
          // このアカウントにまだ選択状態が無ければ(=サーバーにも configured なエントリが
          // 無く、ローカルにも無い)primary をデフォルト選択し、その場で watch も登録し、
          // 次回別端末でも同じ選択になるようサーバーにも保存する(初回連携時)
          const alreadySelected = visibleCalendarsRef.current[account.id] !== undefined;
          const primary = calendars.find((c) => c.primary) ?? calendars[0];
          setVisibleCalendarsState((prev) => {
            if (prev[account.id] !== undefined) return prev; // 既に選択状態があるなら上書きしない
            if (!primary) return prev;
            return { ...prev, [account.id]: [primary.id] };
          });
          if (!alreadySelected && primary) {
            postWatch(account.id, primary.id, true);
            putVisibleCalendars(account.id, [primary.id]);
          }
        } catch (err) {
          console.error("kichijitsu: failed to load calendars", err);
        } finally {
          fetchInFlightRef.current.delete(account.id);
        }
      }
    },
    [checkedFetch, postWatch, putVisibleCalendars],
  );

  // me.accounts が増えるたびに、まだ取得していないアカウントのカレンダー一覧を取りに行く(初回のみ)
  useEffect(() => {
    const toFetch = me.accounts.filter((a) => !fetchedAccountsRef.current.has(a.id));
    if (toFetch.length === 0) return;
    for (const account of toFetch) fetchedAccountsRef.current.add(account.id);

    let cancelled = false;
    fetchCalendarsFor(toFetch, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [me.accounts, fetchCalendarsFor]);

  // アカウント一覧ぶんのタスクリスト一覧を取得する(docs/google-tasks.md)。fetchCalendarsFor と
  // 対になる処理だが、タスクは v1 でトグル UI が無いためデフォルト選択・watch 登録の類は無く、
  // 単純に一覧を state へ反映するだけでよい。tasks スコープ未付与のアカウントは
  // GET /api/tasklists が 403 を返す想定 — その場合はタスク機能オフとして静かにスキップする
  // (審査ポリシー上、未使用スコープは要求しないため実装済みでもユーザーが同意していなければ 403 になる)。
  // バックエンド不在(502 相当)やその他のネットワークエラーもコンソールを汚さないよう warn 止まりにする。
  const fetchTaskListsFor = useCallback(
    async (accounts: AccountDTO[], isCancelled: () => boolean) => {
      for (const account of accounts) {
        try {
          const res = await checkedFetch(
            `/api/tasklists?accountId=${encodeURIComponent(account.id)}`,
          );
          if (res.status === 403) {
            // tasks スコープ未付与: タスク一覧の取得自体は静かにスキップしつつ、
            // 設定モーダルの再連携導線用にアカウント id を覚えておく(挙動は従来どおり)。
            if (isCancelled()) return;
            setTasksScopeMissingAccounts((prev) => addToSet(prev, account.id));
            continue;
          }
          if (!res.ok) {
            console.warn(`kichijitsu: GET /api/tasklists failed (${account.id}): ${res.status}`);
            continue;
          }
          const data = (await res.json()) as TaskListsResponse;
          if (isCancelled()) return;
          setTaskListsByAccount((prev) => ({ ...prev, [account.id]: data.taskLists }));
          // スコープを得られた(200)ので未付与集合から外す ―― 再連携後の再取得で消える
          setTasksScopeMissingAccounts((prev) => removeFromSet(prev, account.id));
        } catch (err) {
          console.warn("kichijitsu: failed to load task lists", err);
        }
      }
    },
    [checkedFetch],
  );

  // me.accounts が増えるたびに、まだ取得していないアカウントのタスクリスト一覧を取りに行く(初回のみ)
  useEffect(() => {
    const toFetch = me.accounts.filter((a) => !fetchedTaskAccountsRef.current.has(a.id));
    if (toFetch.length === 0) return;
    for (const account of toFetch) fetchedTaskAccountsRef.current.add(account.id);

    let cancelled = false;
    fetchTaskListsFor(toFetch, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [me.accounts, fetchTaskListsFor]);

  // 設定パネルを開いたとき、カレンダー一覧がまだ無いアカウント(未取得中、または
  // 初回フェッチが失敗して calendarsByAccount に一度もエントリが入らなかったもの)を
  // 再フェッチする。panelOpen が true になった瞬間にのみ試みる(閉じている間や、
  // 開いたままの再レンダーごとに何度も走らないよう依存を panelOpen だけに絞る)
  useEffect(() => {
    if (!panelOpen) return;
    const toRetry = me.accounts.filter((a) => calendarsByAccount[a.id] === undefined);
    if (toRetry.length === 0) return;
    let cancelled = false;
    fetchCalendarsFor(toRetry, () => cancelled);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen]);

  // MCP トークン一覧 + 発行/失効(hooks/useMcpTokens.ts)。取得タイミング(設定パネルが
  // 開いた瞬間だけ)も含めてフック側にあるので、ここは配線だけ
  const {
    mcpTokens,
    createMcpToken: handleCreateMcpToken,
    deleteMcpToken: handleDeleteMcpToken,
  } = useMcpTokens({ panelOpen, checkedFetch });

  // 1つの (accountId, calendarId) の同期の実処理。syncCalendar (下) から
  // syncSchedulerRef 経由でのみ呼ぶ(直接呼ばない — 多重実行ガードを迂回してしまうため)。
  // forceFull (2026-07-22、同期バックフィル用) は通常同期では省略して
  // false 扱いにする — runSyncBackfillIfNeeded だけが明示的に true を渡す
  const syncCalendarOnce = useCallback(
    async (accountId: string, calendarId: string, defaultColor?: string, forceFull = false) => {
      if (!db) return;
      // postJson ではなく sendJson なのは、失敗メッセージに (accountId/calendarId) を残すため
      // ―― どのカレンダーの同期が失敗したかが console から読めなくなるのを避ける
      const syncRes = await sendJson(
        checkedFetch,
        "POST",
        "/api/sync",
        buildSyncRequest(
          accountId,
          calendarId,
          deviceIdRef.current,
          forceFull,
        ) satisfies SyncRequest,
      );
      if (!syncRes.ok) {
        throw new Error(`POST /api/sync failed (${accountId}/${calendarId}): ${syncRes.status}`);
      }
      const syncData = (await syncRes.json()) as SyncResponse;
      await applySyncResponse(db, store, allDayStore, syncData, {
        accountId,
        calendarId,
        defaultColor,
      });
    },
    [db, store, allDayStore, checkedFetch],
  );

  // 1つの (accountId, calendarId) を同期する共通処理。runSync のループ、SSE hello/changed、
  // カレンダーを新規選択した直後の即時同期など複数経路から await なしで多重に発火しうるため、
  // syncSchedulerRef (キー = `${accountId}:${calendarId}`) で直列化する。同一カレンダーの
  // 増分同期と全同期(410 フォールバック)が交錯して IndexedDB の削除→再投入が競合するのを防ぐ
  // (2026-07-21、sync/syncScheduler.ts 参照)。
  // forceFull はそのまま syncCalendarOnce に通す — ただし schedule() は同一キーの走行中は
  // 新しい run を無視して既存の run を再実行するだけ(sync/syncScheduler.ts の runLoop 参照)
  // なので、理論上「非 forceFull の同期が走行中に forceFull の要求が来る」と forceFull が
  // 無視されて通常の再実行になり得る。runSyncBackfillIfNeeded は起動時の runSync 完了を
  // 待ってから呼ぶ設計にしてあるため実運用でこの競合はほぼ起きないが、完全に排除はしていない
  const syncCalendar = useCallback(
    (accountId: string, calendarId: string, defaultColor?: string, forceFull = false) =>
      syncSchedulerRef.current.schedule(calendarKey(accountId, calendarId), () =>
        syncCalendarOnce(accountId, calendarId, defaultColor, forceFull),
      ),
    [syncCalendarOnce],
  );

  // 1つの (accountId, taskListId) を同期する共通処理(docs/google-tasks.md、syncCalendar のタスク版)。
  // Tasks API には syncToken が無く、応答は常にそのタスクリストの全件 (protocol.ts 参照)。
  const syncTaskList = useCallback(
    async (accountId: string, taskListId: string) => {
      if (!db) return;
      // syncCalendarOnce と同じ理由で sendJson 止まり(メッセージの (accountId/taskListId) を残す)
      const res = await sendJson(checkedFetch, "POST", "/api/tasks/sync", {
        accountId,
        taskListId,
      } satisfies TasksSyncRequest);
      if (!res.ok) {
        throw new Error(`POST /api/tasks/sync failed (${accountId}/${taskListId}): ${res.status}`);
      }
      const data = (await res.json()) as TasksSyncResponse;
      await applyTasksSyncResponse(db, taskStore, data, { accountId, taskListId });
    },
    [db, taskStore, checkedFetch],
  );

  // 選択中の全 (accountId, calendarId) ペア一覧(+ カレンダーのデフォルト色・primary か)。
  // 手動同期ボタン・自動同期・SSE hello 受信時の一巡 sync がいずれもこれを起点にする。
  // primary フラグは新規予定の書き込み先決定 (defaultWriteTarget、フェーズ5) にも使う
  const selectedTargets = useCallback((): WriteTargetCandidate[] => {
    const targets: WriteTargetCandidate[] = [];
    for (const account of me.accounts) {
      const calendars = calendarsByAccount[account.id] ?? [];
      for (const calendarId of visibleCalendars[account.id] ?? []) {
        const cal = calendars.find((c) => c.id === calendarId);
        targets.push({
          accountId: account.id,
          calendarId,
          primary: cal?.primary,
          defaultColor: cal?.backgroundColor,
        });
      }
    }
    return targets;
  }, [me.accounts, calendarsByAccount, visibleCalendars]);

  // 取得済みの全 (accountId, taskListId) ペア一覧。v1 はタスクリストの表示 ON/OFF が無いため
  // (docs/google-tasks.md の TODO)、fetchTaskListsFor で取れたものは無条件に同期対象にする
  const selectedTaskListTargets = useCallback((): TaskListTarget[] => {
    const targets: TaskListTarget[] = [];
    for (const account of me.accounts) {
      for (const taskList of taskListsByAccount[account.id] ?? []) {
        targets.push({ accountId: account.id, taskListId: taskList.id });
      }
    }
    return targets;
  }, [me.accounts, taskListsByAccount]);

  // 新規予定 (フェーズ5) のデフォルトの書き込み先: 選択中カレンダーのうち primary が
  // あればそれ、無ければ先頭 (resolveDefaultWriteTarget、規則は eventCreate.ts 参照)。
  // null なら空き領域クリック/ドラッグでの新規作成自体を無効化する (WeekGrid/DayColumn 側)
  const defaultWriteTarget = useMemo(
    () => resolveDefaultWriteTarget(selectedTargets()),
    [selectedTargets],
  );

  // 「同期」ボタン・自動同期の共通処理: 選択中の全 (accountId, calendarId) ペア +
  // 取得済みの全 (accountId, taskListId) ペアを並行に同期する(docs/google-tasks.md でタスクも合流)
  const runSync = useCallback(async () => {
    if (!db) return;
    const targets = selectedTargets();
    const taskTargets = selectedTaskListTargets();
    if (targets.length === 0 && taskTargets.length === 0) return;

    setSyncStatus("syncing");
    const results = await Promise.allSettled([
      ...targets.map((t) => syncCalendar(t.accountId, t.calendarId, t.defaultColor)),
      ...taskTargets.map((t) => syncTaskList(t.accountId, t.taskListId)),
    ]);
    let hadError = false;
    for (const result of results) {
      if (result.status === "rejected") {
        hadError = true;
        console.error("kichijitsu: sync failed", result.reason);
      }
    }
    setSyncStatus(hadError ? "error" : "idle");
  }, [db, selectedTargets, syncCalendar, selectedTaskListTargets, syncTaskList]);

  // 同期バックフィル (2026-07-22、旧 runOooBackfillIfNeeded の一般化。db/database.ts の
  // CURRENT_SYNC_BACKFILL_VERSION コメント参照)。起動時の自動同期 (runSync、下の useEffect) が
  // 終わった直後に1回だけ呼ぶ: runSync 自体を forceFull にはしない(手動「同期」ボタンや
  // SSE hello/changed からも runSync/syncCalendar 経由の通常同期が随時走るため、runSync 自体を
  // forceFull 化すると毎回全同期になってしまう。起動直後の1回だけ、という条件を素直に表せるのは
  // こちらの「runSync の後に別途走らせる」方式のほうだった)。
  //
  // 選択中の全 (accountId, calendarId) を forceFull: true で同期し、1つも失敗しなければ
  // 現行世代 (CURRENT_SYNC_BACKFILL_VERSION) を保存する。一部でも失敗したら保存せず、次回起動時に
  // また全対象を再試行する(部分的に古いままのカレンダーを残さないため — db/database.ts の
  // setSyncBackfillVersion コメント参照)。
  const runSyncBackfillIfNeeded = useCallback(async () => {
    if (!db) return;
    const savedVersion = await getSyncBackfillVersion(db);
    const targets = decideSyncBackfillTargets(
      savedVersion,
      CURRENT_SYNC_BACKFILL_VERSION,
      selectedTargets(),
    );
    if (targets.length === 0) return;

    const results = await Promise.allSettled(
      targets.map((t) => syncCalendar(t.accountId, t.calendarId, t.defaultColor, true)),
    );
    const allOk = results.every((r) => r.status === "fulfilled");
    if (allOk) {
      await setSyncBackfillVersion(db, CURRENT_SYNC_BACKFILL_VERSION);
    } else {
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("kichijitsu: sync backfill failed, will retry next launch", result.reason);
        }
      }
    }
  }, [db, selectedTargets, syncCalendar]);

  // SSE hello 受信時(接続・再接続時): 取りこぼしがあり得るため選択中カレンダーを一巡 sync する。
  // runSync と違い、同時多発を避けて直列(1件ずつ await)で回す
  const handleServerHello = useCallback(async () => {
    if (!db) return;
    const targets = selectedTargets();
    if (targets.length === 0) return;

    setSyncStatus("syncing");
    let hadError = false;
    for (const t of targets) {
      try {
        await syncCalendar(t.accountId, t.calendarId, t.defaultColor);
      } catch (err) {
        hadError = true;
        console.error("kichijitsu: SSE hello sync failed", err);
      }
    }
    setSyncStatus(hadError ? "error" : "idle");
  }, [db, selectedTargets, syncCalendar]);

  // SSE changed 受信時: 該当 (accountId, calendarId) が選択中の場合のみ sync する
  // (通知のペイロード自体は信用せず、選択状態は常にクライアント側の visibleCalendars で判定する)
  const handleServerChanged = useCallback(
    (accountId: string, calendarId: string) => {
      if (!db) return;
      if (!(visibleCalendars[accountId] ?? []).includes(calendarId)) return;
      const defaultColor = calendarsByAccount[accountId]?.find(
        (c) => c.id === calendarId,
      )?.backgroundColor;

      setSyncStatus("syncing");
      syncCalendar(accountId, calendarId, defaultColor)
        .then(() => setSyncStatus("idle"))
        .catch((err) => {
          console.error("kichijitsu: SSE changed sync failed", err);
          setSyncStatus("error");
        });
    },
    [db, visibleCalendars, calendarsByAccount, syncCalendar],
  );

  // アカウントが1つ以上連携済みの間だけ SSE (GET /api/events) に接続する。
  // hello/changed のハンドラは上の handleServerHello/handleServerChanged に委譲し、
  // 接続状態は useOffline (markOnline/markOffline) と連動させる
  useServerEvents({
    enabled: me.accounts.length > 0,
    onHello: handleServerHello,
    onChanged: handleServerChanged,
    onOpen: markOnline,
    onError: markOffline,
  });

  // 接続済み & DB 準備完了 & 選択中カレンダーが読み込まれたら起動時に1回だけ自動同期する。
  // 完了後に続けて runSyncBackfillIfNeeded を1回だけ走らせる(2026-07-22) — 通常同期
  // (runSync 自体)とバックフィルの forceFull 同期が同時に飛んで syncScheduler 上で
  // 競合しないよう、意図的に「まず通常同期が完了してから」の直列にしてある
  useEffect(() => {
    if (!db || me.accounts.length === 0 || Object.keys(visibleCalendars).length === 0) return;
    if (autoSyncedRef.current) return;
    autoSyncedRef.current = true;
    runSync().then(() => runSyncBackfillIfNeeded());
  }, [db, me.accounts, visibleCalendars, runSync, runSyncBackfillIfNeeded]);

  // タスクリストが新たに見つかるたびに、その (accountId, taskListId) を1回だけ自動同期する
  // (docs/google-tasks.md)。fetchTaskListsFor の完了タイミングは calendarsByAccount/visibleCalendars の
  // 準備完了と揃わないことがあるため、上の「起動時1回だけ」の autoSyncedRef とは別に、
  // タスクリスト単位で「初めて見つかった」ことを autoSyncedTaskListsRef で判定する。
  // Tasks API には push 通知が無い (docs/google-tasks.md) ため、以降の更新反映は「同期」ボタン
  // (runSync) 頼みになる — TODO: 定期ポーリングでの自動更新
  useEffect(() => {
    if (!db) return;
    const targets = selectedTaskListTargets();
    const toSync = targets.filter(
      (t) => !autoSyncedTaskListsRef.current.has(taskListKey(t.accountId, t.taskListId)),
    );
    if (toSync.length === 0) return;
    for (const t of toSync)
      autoSyncedTaskListsRef.current.add(taskListKey(t.accountId, t.taskListId));
    Promise.allSettled(toSync.map((t) => syncTaskList(t.accountId, t.taskListId))).then(
      (results) => {
        for (const result of results) {
          if (result.status === "rejected") {
            console.error("kichijitsu: initial task list sync failed", result.reason);
          }
        }
      },
    );
  }, [db, taskListsByAccount, selectedTaskListTargets, syncTaskList]);

  // 左ペイン(CalendarPane、カレンダーナビゲーション増分1)でのカレンダー表示チェック操作
  // (旧: カレンダー設定パネル内のチェック、増分1で CalendarPane へ移設。ロジックは無変更)。
  // 選択時は即座にそのカレンダーだけ同期し、選択解除時はその (accountId, calendarId) の
  // ローカルデータを削除して store から取り除く
  const handleToggleCalendar = useCallback(
    (accountId: string, calendarId: string, nextChecked: boolean) => {
      const current = visibleCalendars[accountId] ?? [];
      const nextForAccount = nextChecked
        ? current.includes(calendarId)
          ? current
          : [...current, calendarId]
        : current.filter((id) => id !== calendarId);
      setVisibleCalendarsState((prev) => ({ ...prev, [accountId]: nextForAccount }));
      postWatch(accountId, calendarId, nextChecked);
      // サーバーへ保存(端末間同期、2026-07-20)。UI/IndexedDB は上ですでに楽観的更新済み
      putVisibleCalendars(accountId, nextForAccount);

      if (!db) return;

      // 選択解除では IndexedDB のデータを削除しない。表示は WeekGrid の
      // visibleCalendarKeys フィルタで隠すだけにする。削除してしまうと、
      // 再選択時にサーバーの syncToken が残っているため増分同期(変更なし=空)が返り、
      // 削除済みデータが復活せず空表示になる既知のバグだった(2026-07-20 修正)。
      // 再選択は即座に再表示され、同期の往復もちらつきも不要。実データの削除は
      // アカウント連携解除(handleDisconnectAccount)のときだけ行う。
      if (nextChecked) {
        const cal = calendarsByAccount[accountId]?.find((c) => c.id === calendarId);
        syncCalendar(accountId, calendarId, cal?.backgroundColor).catch((err) => {
          console.error("kichijitsu: failed to sync newly selected calendar", err);
        });
      }
    },
    [db, visibleCalendars, calendarsByAccount, syncCalendar, postWatch, putVisibleCalendars],
  );

  // 左ペイン(CalendarPane、増分2)でのタスクリスト表示チェック操作。カレンダー選択
  // (handleToggleCalendar)と違いサーバー同期は行わず、ローカルの hiddenTaskLists
  // (「明示的に OFF にした集合」)を更新するだけ ―― タスクの同期(syncTaskList)自体は
  // 表示 ON/OFF に関係なく続行する(selectedTaskListTargets 参照、再 ON 時の即時性を優先)
  const handleToggleTaskList = useCallback(
    (accountId: string, taskListId: string, nextChecked: boolean) => {
      const key = taskListKey(accountId, taskListId);
      // 表示 ON なら「非表示集合」から外す / OFF なら入れる。setOps は変化が無ければ同じ参照を
      // 返すので、同じ状態のまま呼ばれても無駄な再レンダー/再永続化が起きない
      setHiddenTaskListsState((prev) =>
        nextChecked ? removeFromSet(prev, key) : addToSet(prev, key),
      );
    },
    [],
  );

  // 左ペイン(CalendarPane)の「表示」セクションにある2チェックの操作(参加ステータス表示、
  // 2026-07-22)。hiddenTaskLists と同じくローカル state を直接更新するだけ(サーバー同期無し)。
  // 「不参加を表示」チェック本体。
  const handleToggleShowDeclined = useCallback(() => {
    setDeclinedVisibilityState((prev) => ({ ...prev, showDeclined: !prev.showDeclined }));
  }, []);

  // サブオプション「自分が主催の予定は残す」。showDeclined が true のときは意味を持たない
  // (shouldHideDeclined 参照)が、状態自体は独立して保持する(再度 showDeclined を OFF にした
  // ときに前回の選択を覚えていてほしいため)。
  const handleToggleKeepOrganizerDeclined = useCallback(() => {
    setDeclinedVisibilityState((prev) => ({
      ...prev,
      keepOrganizerDeclined: !prev.keepOrganizerDeclined,
    }));
  }, []);

  // アカウント単位の連携解除。サーバー側 (Google revoke + データ削除 + cookie 更新) を
  // DELETE /api/account に任せ、成功したらそのアカウントに関する状態(accounts・カレンダー一覧・
  // 選択状態・ローカルの google データ)を全て畳む。失敗時は呼び出し元(パネルの行UI)が
  // catch して表示するので、ここでは reject をそのまま伝播する
  const handleDisconnectAccount = useCallback(
    async (accountId: string) => {
      await deleteJson(checkedFetch, "/api/account", { accountId } satisfies DisconnectRequest);

      setMe((prev) => {
        const accounts = prev.accounts.filter((a) => a.id !== accountId);
        const { [accountId]: _removedVisible, ...remainingVisibleCalendars } =
          prev.visibleCalendars;
        return {
          ...prev,
          connected: accounts.length > 0,
          accounts,
          visibleCalendars: remainingVisibleCalendars,
        };
      });
      setCalendarsByAccount((prev) => {
        const { [accountId]: _removed, ...rest } = prev;
        return rest;
      });
      setVisibleCalendarsState((prev) => {
        const { [accountId]: _removed, ...rest } = prev;
        return rest;
      });
      fetchedAccountsRef.current.delete(accountId);

      // タスク側の状態も畳む(docs/google-tasks.md)。カレンダーと同じ流儀
      setTaskListsByAccount((prev) => {
        const { [accountId]: _removed, ...rest } = prev;
        return rest;
      });
      fetchedTaskAccountsRef.current.delete(accountId);
      setTasksScopeMissingAccounts((prev) => removeFromSet(prev, accountId));
      for (const key of [...autoSyncedTaskListsRef.current]) {
        if (key.startsWith(`${accountId}:`)) autoSyncedTaskListsRef.current.delete(key);
      }

      if (db) {
        const { deletedOccurrenceIds, deletedAllDayIds } = await deleteGoogleData(
          db,
          (k) => k.accountId === accountId,
        );
        store.remove(deletedOccurrenceIds);
        allDayStore.remove(deletedAllDayIds);
        await deleteTasksForAccount(db, taskStore, accountId);
      }
    },
    [db, store, allDayStore, taskStore, checkedFetch],
  );

  // GitHub 連携解除 (docs/github-integration.md フェーズ①Part B)。DELETE /api/github で
  // サーバー側の github_connections 行を消し、成功したら me.github を null に戻して
  // ローカルの GitHub アイテムも畳む(IndexedDB/store の両方)。失敗時は呼び出し元
  // (設定パネルのインライン確認 UI、handleDisconnectAccount と同じ流儀)が catch して表示する
  const handleDisconnectGitHub = useCallback(async () => {
    await deleteJson(checkedFetch, "/api/github");
    setMe((prev) => ({ ...prev, github: null }));
    // GitHub 由来のローカルデータ(作業キュー・実績/CI オーバーレイ・再連携フラグの state と、
    // IndexedDB/store のアイテムレーン)を畳むのは useGitHubData 側の責務
    await clearGitHubData();
  }, [checkedFetch, clearGitHubData]);

  /**
   * 予定・タスクの変更系(hooks/useEventMutations.ts)。ドラッグ/リサイズの確定・新規作成・
   * 削除・編集フォーム保存・RSVP・移動確認ダイアログ・タスクの完了トグルと、それらの
   * ロールバック通知 (saveError) が入っている。楽観更新→失敗時ロールバックの順序、
   * override の既存 patch マージ、422→RsvpNotAttendeeError の振り替えはすべてフック側。
   *
   * 呼び出し位置は移設前に flashSaveError / handlePersist 等があったここに揃えてある ――
   * このフックが登録する effect は saveError のタイマークリア(依存 [])1本だけなので
   * 位置の自由度は高いが、effect の登録順を移設前と同じに保つため動かしていない。
   * 返り値は JSX 側の既存の名前に別名で受けて、呼び出し箇所を一切変えずに済ませている。
   */
  const {
    saveError,
    persist: handlePersist,
    createEvent: handleCreate,
    deleteOccurrence: handleDeleteOccurrence,
    moveConfirm,
    requestMoveConfirm: handleRequestMoveConfirm,
    confirmMove: handleConfirmMove,
    cancelMove: handleCancelMove,
    saveEdit: handleEditSave,
    rsvp: handleRsvp,
    toggleTask: handleToggleTask,
  } = useEventMutations({ db, store, allDayStore, taskStore, checkedFetch, timeZone });

  /**
   * 予定タイムブロック(hooks/usePlannedBlockHandlers.ts)。作成(ドラッグ&ドロップ)/移動・
   * リサイズ/削除の3ハンドラで、いずれも plannedStore と IndexedDB だけを更新する
   * ローカル専用の経路(ネットワーク呼び出しは無い)。effect を持たないので位置の制約は無いが、
   * 移設前と同じここに置いてある。返り値は JSX 側の既存の名前に別名で受けている。
   */
  const {
    dropWorkItem: onDropWorkItem,
    movePlannedBlock: onMovePlannedBlock,
    deletePlannedBlock: onDeletePlannedBlock,
  } = usePlannedBlockHandlers({ db, plannedStore });

  // ---- 手動タイマー・実績記録 (実績 UX 刷新フェーズ5b、2026-07-23) ----
  // 走行中(実行中)状態は「サーバーの開区間(GET /api/work-logs/open)」を単一の真実とする。
  // 開区間の取得と45秒ポーリング・▶/⏹・1秒 tick・timeEntryStore への射影は
  // hooks/useTimers.ts、hook 実績 (work_logs) の一覧と取得/作成/更新/削除は
  // hooks/useWorkLogs.ts へ移した(リファクタリング フェーズ2 ⑤、2026-07-25)。
  // 依存の張り方(tick は 0↔非0 の遷移、射影は plannedVersion、ポーリングは me.github)は
  // フック側のコメント参照 ―― ここは配線だけ。

  // hook 実績・commit 推定の取得トリガー(docs/github-integration.md「時間計測」増分2 Part B、
  // GitHubPane 増分2で拡張)。当初は TimeReportOverlay を開いたとき(reportOpen)だけだったが、
  // 右ペイン(GitHubPane)の実績セクションも同じデータを使うため、「ペインが開いていて
  // GitHub 連携済み」でも取得するよう広げる。GitHubPane 自体が `paneOpen && me.github` でしか
  // 描画されない(App.tsx 下部の render 参照)ため、この条件は「実績セクションが実際に見えている」
  // と同値 — 二重取得(reportOpen と paneOpen が両方 true でも1回の effect 実行にしかならない)は
  // 依存配列がそのまま防ぐ。2026-07-25 に WorkLogModal を廃止し、その開閉フラグ(workLogModalOpen)
  // をこの条件から外した ―― 実績 UI はすべて paneOpen 経路に集約された。
  // 宣言位置が移設前(タイマー系 effect の後)より前に上がっているのは、useWorkLogs/useTimers の
  // 両方が引数に取るため(hooks はレンダー中に評価されるので参照より前に確定していなければならない)。
  // 値の導き方そのものは無変更。
  const needsActualsData = reportOpen || (paneOpen && !!me.github);

  /**
   * hook 実績 (work_logs) の一覧と書き込み(hooks/useWorkLogs.ts)。useTimers より先に呼ぶ:
   * ⏹ の成功後に走る work-logs 再取得 (refetchWorkLogs) を useTimers へ渡す必要があるため。
   * この順序により「needsActualsData で work-logs を取り、その後で開区間を取り直す」という
   * 移設前の commit 内の順序もそのまま保たれる(useTimers 側のコメント参照)。
   */
  const {
    workLogs: reportWorkLogs,
    refetch: refetchWorkLogs,
    create: handleCreateWorkLog,
    update: handleUpdateWorkLog,
    remove: handleDeleteWorkLog,
  } = useWorkLogs({ needsActualsData, checkedFetch });

  /**
   * 手動タイマー(hooks/useTimers.ts)。開区間のポーリング・▶/⏹・経過表示用の1秒 tick・
   * 開区間 → timeEntryStore の射影が入っている。
   */
  const {
    runningTimeEntries,
    timerNowMs,
    startTimer: onStartTimer,
    stopTimer: onStopTimer,
  } = useTimers({
    github: me.github,
    needsActualsData,
    plannedStore,
    timeEntryStore,
    githubQueue,
    checkedFetch,
    refetchWorkLogs,
  });

  // 予定 vs 実績レポート(TimeReportOverlay)用の全件購読。オーバーレイが閉じていても
  // フックはトップレベルで無条件に呼ぶ(Rules of Hooks) — 実際に使うのは reportOpen 時のみ
  const reportPlannedBlocks = useAllPlannedBlocks(plannedStore);
  const reportTimeEntries = useTimeEntries(timeEntryStore);

  const reportHookActualByLinkedItem = useMemo(
    () =>
      hookActualByLinkedItem(
        reportWorkLogs,
        reportPlannedBlocks.map((b) => b.linkedItemId),
      ),
    [reportWorkLogs, reportPlannedBlocks],
  );

  // commit からの実績自動推定 (docs/github-integration.md「時間計測」増分3 Part B) は
  // hooks/useGitHubData.ts の useGitHubPrCommitEstimates へ移した(リファクタリング フェーズ2 ③、
  // 2026-07-25)。needsActualsData(レポートを開いた、または実績セクションが可視)のときだけ
  // POST /api/github/pr-commits を叩く条件、対象を PR だけに絞る collectPrTargets、401/409/502 の
  // 扱いはフック側にある。useGitHubData 本体と別フックなのは、依存する needsActualsData と
  // reportPlannedBlocks/reportTimeEntries がここまで来ないと確定しない(= 上の useGitHubData の
  // 呼び出し位置からは参照できない)ため ―― 呼び出し位置も移設前の effect と同じここに置いて
  // 登録順を保っている。401 は useGitHubData の githubAuthExpired へ合流させる
  const { prCommitEstimates, prCommitEstimatesLoading } = useGitHubPrCommitEstimates({
    enabled: needsActualsData,
    github: me.github,
    plannedBlocks: reportPlannedBlocks,
    timeEntries: reportTimeEntries,
    checkedFetch,
    setAuthExpired: setGithubAuthExpired,
  });

  // 'n' ショートカット(新規予定作成、フェーズ6)。書き込み先カレンダーが無ければ何もしない
  // (ボタン起点の作成と同じ制約)。移動そのものは useTimelineNavigation の
  // goToTodayForNewEvent に持たせてあり、ここはそのガードだけを担う薄い配線
  // ―― フックが同期系の state(defaultWriteTarget)を知らずに済むようにするため。
  const handleNewEventShortcut = useCallback(() => {
    if (!defaultWriteTarget) return;
    goToTodayForNewEvent();
  }, [defaultWriteTarget, goToTodayForNewEvent]);

  // ショートカットから呼ぶヘルプ開閉。インラインの矢印関数ではなく useCallback で安定させて
  // あるのは、useGlobalShortcuts の keydown リスナーが毎レンダー張り替わらないようにするため
  // (切り出し前は setHelpOpen を直接呼んでいたので依存に現れなかった)。
  const toggleHelp = useCallback(() => setHelpOpen((v) => !v), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);

  // グローバルキーボードショートカット(フェーズ6)。リスナー本体と
  // 「入力中/他オーバーレイが開いている間は発火させない」ガードは
  // hooks/useGlobalShortcuts.ts にある(依存の粒度も切り出し前と同じ)。
  useGlobalShortcuts({
    isNarrow,
    helpOpen,
    onPrev: goToPrev,
    onNext: goToNext,
    onToday: goToToday,
    onSwitchView: switchView,
    onNewEvent: handleNewEventShortcut,
    onToggleHelp: toggleHelp,
    onCloseHelp: closeHelp,
  });

  // 設定モーダル(SettingsModal、UI 改善で中央モーダルへ格上げ、2026-07-22)の外側クリック・
  // Escape での自動クローズは、コンポーネント自身が持つ useCloseOnOutsideOrEscape に一本化した
  // (BlockRulesOverlay/TimeReportOverlay と同じ流儀)。旧アンカー式ポップオーバー時代は
  // ツールバーのボタン領域 (accountAreaRef) を基準にした専用リスナーがここに必要だったが、
  // 中央固定モーダルになったことで App.tsx 側の個別対応は不要になった。

  // WeekGrid に渡す「選択中カレンダー」キー集合 (`${accountId}:${calendarId}`)
  const visibleCalendarKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const [accountId, calendarIds] of Object.entries(visibleCalendars)) {
      for (const calendarId of calendarIds) keys.add(calendarKey(accountId, calendarId));
    }
    return keys;
  }, [visibleCalendars]);

  // EventBlock の詳細ポップオーバー用: `${accountId}:${calendarId}` → カレンダー名/色
  const calendarLookup = useMemo(() => {
    const lookup = new Map<string, CalendarInfo>();
    for (const [accountId, calendars] of Object.entries(calendarsByAccount)) {
      for (const cal of calendars) {
        lookup.set(calendarKey(accountId, cal.id), {
          summary: cal.summary,
          backgroundColor: cal.backgroundColor,
        });
      }
    }
    return lookup;
  }, [calendarsByAccount]);

  // 検索結果からのジャンプ(SearchOverlay から受け取る唯一のコールバック、フェーズ6)。
  // 対象の予定を含む日へ day1 タイムラインで移動する(月表示セルクリック時の
  // handleNavigateToDay と同じ動線を再利用するだけの薄いラッパー)。
  // 将来 '/' や Cmd+K でオーバーレイを開けるようにする場合は、ショートカット側から
  // このすぐ下の openSearch を呼べばよい(今回はツールバーボタンからの起動のみ配線する)。
  const handleSearchJump = useCallback(
    (target: SearchJumpTarget) => {
      handleNavigateToDay(resolveJumpDate(target, timeZone));
    },
    [handleNavigateToDay, timeZone],
  );
  const openSearch = useCallback(() => setSearchOpen(true), []);

  /*
   * 左右ペイン(CalendarPane/GitHubPane)のトグルボタン用ハンドラ。増分3(左ペイン常設化)で
   * 左ペインは常に docked になったため、この2つはもう対称ではない:
   *   - 左ペインを開くとき: 右ペインが実効 overlay として表示中なら自動的に閉じる
   *     (shouldCloseOtherPaneOnOpen、layout/paneMode.ts。この動線だけはユーザー要望で維持)。
   *   - 右ペインを開くとき: 左ペインは overlay を持たなくなった(常に docked、左右で別領域に
   *     常設するため場所が競合しない)ので、左ペインを閉じる必要は無い ―― 単純に paneOpen を
   *     反転するだけでよい。
   */
  const toggleLeftPane = useCallback(() => {
    setLeftPaneOpen((open) => {
      const opening = !open;
      if (opening && shouldCloseOtherPaneOnOpen(paneMode, paneOpen, isNarrow)) {
        setPaneOpen(false);
      }
      return opening;
    });
  }, [paneMode, paneOpen, isNarrow]);

  const toggleGitHubPane = useCallback(() => {
    setPaneOpen((open) => !open);
  }, []);

  return (
    <div className="app">
      <header className="toolbar">
        <div className="logo-lockup">
          <LogoMark />
          <LogoWordmark />
        </div>
        <div className="toolbar-nav">
          <button
            type="button"
            onClick={goToPrev}
            aria-label={view === "week" ? "前週" : view === "month" ? "前月" : "前へ"}
          >
            ←
          </button>
          <button type="button" onClick={goToToday}>
            今日
          </button>
          <button
            type="button"
            onClick={goToNext}
            aria-label={view === "week" ? "次週" : view === "month" ? "次月" : "次へ"}
          >
            →
          </button>
          {/* 予定検索(フェーズ6)。SearchOverlay 側で入力欄にオートフォーカスする。
           * アイコンは 2026-07-22 に絵文字 🔍 から SearchIcon(フラット SVG)へ置き換え */}
          <button type="button" onClick={openSearch} aria-label="予定を検索">
            <SearchIcon />
          </button>
        </div>
        {/*
         * ビュー切替(フェーズ6で週/月、フェーズ2でday3/day1を追加、docs/multiplatform.md)。
         * 狭幅では Notion Calendar に倣い「1日/3日/月」を出し、広幅では従来通り「週/月」のまま
         * (3日は任意扱いとして広幅ツールバーには出さない)。
         */}
        <div className="toolbar-view-toggle" role="group" aria-label="表示切替">
          {isNarrow ? (
            <>
              <button
                type="button"
                className={view === "day1" ? "is-active" : ""}
                aria-pressed={view === "day1"}
                onClick={() => switchView("day1")}
              >
                1日
              </button>
              <button
                type="button"
                className={view === "day3" ? "is-active" : ""}
                aria-pressed={view === "day3"}
                onClick={() => switchView("day3")}
              >
                3日
              </button>
              <button
                type="button"
                className={view === "month" ? "is-active" : ""}
                aria-pressed={view === "month"}
                onClick={() => switchView("month")}
              >
                月
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={view === "week" ? "is-active" : ""}
                aria-pressed={view === "week"}
                onClick={() => switchView("week")}
              >
                週
              </button>
              <button
                type="button"
                className={view === "month" ? "is-active" : ""}
                aria-pressed={view === "month"}
                onClick={() => switchView("month")}
              >
                月
              </button>
            </>
          )}
        </div>
        {/*
         * 時間軸ズーム(2026-07-25、ユーザー要望)。「表示の粗さ」を決める操作なので
         * ビュー切替(週/月・1日/3日/月)のセグメントの直後に置く ―― 同じ「表示の見え方」を
         * 変える操作をツールバーの同じ塊にまとめる。時間軸を持たない月表示では出さない。
         * 狭幅では compact 表示(プリセットを畳んで −/+ と現在値のみ、HourHeightControl.tsx 参照)。
         */}
        {view !== "month" && (
          <HourHeightControl
            hourHeight={hourHeight}
            onChange={handleHourHeightChange}
            compact={isNarrow}
          />
        )}
        <div className="toolbar-right">
          {/*
           * モバイル狭幅対応: 年月表示を「7月」/「7/20」まで縮める(スマホヘッダー1段化)。
           * 広幅は従来通りフル表記のまま(isNarrow は既存の useMediaQuery state を流用するだけで
           * ロジックの追加は無い)。
           */}
          <span className="month-label">
            {view === "month" ? (
              isNarrow ? (
                <>{monthCursor.month}月</>
              ) : (
                <>
                  {monthCursor.year}年{monthCursor.month}月
                </>
              )
            ) : view === "day1" ? (
              isNarrow ? (
                <>
                  {timelineStart.month}/{timelineStart.day}
                </>
              ) : (
                <>
                  {timelineStart.year}年{timelineStart.month}月{timelineStart.day}日
                </>
              )
            ) : isNarrow ? (
              <>{timelineStart.month}月</>
            ) : (
              <>
                {timelineStart.year}年{timelineStart.month}月
              </>
            )}
          </span>
          {offline && (
            <span
              className="offline-indicator"
              title="サーバーに接続できません。表示はローカルに保存されたデータです"
            >
              <span className="masu masu--empty" aria-hidden="true" />
              <span className="offline-indicator-label">オフライン</span>
            </span>
          )}
          <div className="toolbar-account">
            {me.accounts.length > 0 ? (
              <>
                <button
                  type="button"
                  className="account-summary"
                  onClick={() => setPanelOpen((open) => !open)}
                  aria-expanded={panelOpen}
                  aria-haspopup="dialog"
                  // 「○アカウント連携中」というラベルは何のボタンか分かりづらい (ユーザー指摘
                  // 2026-07-22) ため、歯車アイコン + 「設定」ラベルにして設定画面を開くボタンで
                  // あることを前面に出す。連携中のアカウント (email / 件数) は説明的な title/
                  // aria-label に退避させ、必要な人には読めるようにしておく
                  title={
                    me.accounts.length === 1
                      ? `設定 (${me.accounts[0].email})`
                      : `設定 (${me.accounts.length}アカウント連携中)`
                  }
                  aria-label={
                    me.accounts.length === 1
                      ? `設定 (${me.accounts[0].email})`
                      : `設定 (${me.accounts.length}アカウント連携中)`
                  }
                >
                  <span className="account-gear" aria-hidden="true">
                    <GearIcon width={16} height={16} />
                  </span>
                  <span className="account-summary-label">設定</span>
                </button>
                <button
                  type="button"
                  className="toolbar-sync-btn"
                  onClick={runSync}
                  disabled={syncStatus === "syncing"}
                  aria-label="同期"
                  title="同期"
                >
                  {syncIndicator.visible ? (
                    <span
                      className={
                        syncIndicator.fading
                          ? "sync-indicator masu-indicator--fading"
                          : "sync-indicator"
                      }
                    >
                      <MasuIndicator size="sm" />
                      {/* 狭幅ではテキストを省き枡アイコンのみにして幅を詰める(1段化) */}
                      {!isNarrow && "同期中"}
                    </span>
                  ) : isNarrow ? (
                    "⟳"
                  ) : (
                    "同期"
                  )}
                </button>
                {syncStatus === "error" && <span className="sync-error">同期失敗</span>}
                {saveError && <span className="sync-error">保存失敗（元に戻しました）</span>}
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  window.location.href = "/auth/login";
                }}
              >
                Google 連携
              </button>
            )}
          </div>
          {/*
           * 左ペイン「カレンダー」(CalendarPane、カレンダーナビゲーション増分1)の開閉導線。
           * 連携アカウントが1件も無ければ出す意味が無い(CalendarPane 自体は「連携中の
           * アカウントがありません」を表示できるが、導線自体を隠した方が分かりやすい ――
           * GitHubPane の me.github ゲートと同じ考え方)。
           */}
          {me.accounts.length > 0 && (
            <button
              type="button"
              className="toolbar-calendar-btn"
              onClick={toggleLeftPane}
              aria-label="カレンダー"
              title="カレンダー"
              aria-expanded={leftPaneOpen}
              aria-haspopup="dialog"
            >
              {/* 2026-07-22: 絵文字 📅 から CalendarIcon(フラット SVG)へ置き換え */}
              <span aria-hidden="true">
                <CalendarIcon />
              </span>
              {!isNarrow && <span className="toolbar-calendar-label">カレンダー</span>}
            </button>
          )}
          {/*
           * 「実績」ボタン(実績 UX 刷新、2026-07-23 → 2026-07-25 に右ペイントグルへ変更)。
           * 実績の記録/タイマー/履歴は右ペイン(GitHubPane)に集約されたため、このボタンは
           * モーダルではなく右ペインの開閉トグルになった(paneOpen を共有 ―― CalendarPane の
           * 「作業キュー」ボタンと同じ state)。ラベルは「実績」のまま、title でペインが開く
           * ことを補足する。表示条件はペインの描画条件(me.github)と揃える ―― GitHub 未連携で
           * 押しても何も開かない、という状態を作らないため。
           */}
          {me.github && (
            <button
              type="button"
              className="toolbar-actuals-btn"
              onClick={toggleGitHubPane}
              aria-label="実績(記録・タイマー・履歴)"
              title="実績(右ペインを開く: 実行中・作業キュー・記録・履歴)"
              aria-expanded={paneOpen}
            >
              <span aria-hidden="true">
                <TimerIcon />
              </span>
              {!isNarrow && <span className="toolbar-actuals-label">実績</span>}
            </button>
          )}
          {/*
           * ヘッダー整理(増分3、2026-07-22、ユーザー要望「ヘッダーのメニューを減らしたい」)で
           * 「作業キュー」開閉ボタン(GitHubPane トグル + 件数バッジ)・「レポート」ボタン
           * (TimeReportOverlay トグル)・実績オーバーレイ/CI トグル(増分2で既に移設済み)を
           * すべて CalendarPane の GitHub セクションへ集約した。ここに残すのは「カレンダーを
           * 開けば辿り着ける操作」ではなく「常に見えている必要がある/カレンダーを開かなくても
           * 使う操作」だけ ―― 走行中タイマー・? ヘルプ・(未ログイン時のみ)規約リンクの
           * フォールバック(下記コメント参照)。
           */}
          {/*
           * 走行中タイマーのインジケーター(増分2)。me 連携有無に関係なく、走行中エントリが
           * 1件でもあれば表示する(コンポーネント自身が0件時に null を返す)。
           */}
          <RunningTimersIndicator
            runningEntries={runningTimeEntries}
            nowMs={timerNowMs}
            onStop={onStopTimer}
          />
          {/* キーボードショートカット ヘルプ(フェーズ6)。'?' キーと同じトグル */}
          <button
            type="button"
            className="toolbar-help-btn"
            onClick={() => setHelpOpen((v) => !v)}
            aria-label="キーボードショートカット一覧"
            title="キーボードショートカット (?)"
          >
            ?
          </button>
          {/*
           * プライバシー/規約リンクは増分3で CalendarPane のフッターへ移設したが、
           * CalendarPane 自体は `me.accounts.length > 0` ゲートの内側(未ログイン時は
           * マウントされない)なので、未ログインの訪問者には規約リンクへの導線が一切
           * 無くなってしまう ―― Google 審査要件上、法的リンクは常時到達可能でなければ
           * ならないため、未ログイン時(accounts.length === 0)だけツールバーの従来位置に
           * フォールバック表示する。ログイン後は CalendarPane 側にしか出さない(重複を避ける)。
           * 狭幅で隠す旧 CSS ルール(.toolbar-legal { display: none })もこのフォールバックには
           * 適用しない(App.css 参照) ―― 未ログイン時は他に規約リンクへ辿り着く手段が
           * 無いため、狭幅でも常に見せる。
           */}
          {me.accounts.length === 0 && (
            <div className="toolbar-legal toolbar-legal--fallback">
              <a href="/privacy.html">プライバシー</a>
              <a href="/terms.html">規約</a>
            </div>
          )}
        </div>
      </header>
      <main className="app-main">
        {/*
         * 左ペイン「カレンダー」(CalendarPane、カレンダーナビゲーション増分1)。増分3で
         * オーバーレイ方式を廃止し常に docked になったが、.app-main の直接の子に置いて
         * .app-main-calendar と左右に並べる構造自体は変わらないため、DOM 順序としては
         * こちらを先に置く(flex row のグリッド側が縮む向きは変わらないが、視覚的な
         * 左右関係を DOM 順にも合わせておく)。
         */}
        {leftPaneOpen && me.accounts.length > 0 && (
          <CalendarPane
            onClose={() => setLeftPaneOpen(false)}
            accounts={me.accounts}
            calendarsByAccount={calendarsByAccount}
            visibleCalendars={visibleCalendars}
            onToggleCalendar={handleToggleCalendar}
            view={view}
            timelineStart={timelineStart}
            dayCount={dayCount}
            monthCursor={monthCursor}
            timeZone={timeZone}
            onNavigateDate={handleMiniMonthNavigate}
            taskListsByAccount={taskListsByAccount}
            hiddenTaskListKeys={hiddenTaskLists}
            onToggleTaskList={handleToggleTaskList}
            declinedVisibility={declinedVisibility}
            onToggleShowDeclined={handleToggleShowDeclined}
            onToggleKeepOrganizerDeclined={handleToggleKeepOrganizerDeclined}
            githubLogin={me.github?.login ?? null}
            activityVisible={activityVisible}
            onToggleActivityVisible={handleToggleActivityVisible}
            ciVisible={ciVisible}
            onToggleCiVisible={handleToggleCiVisible}
            githubPaneOpen={paneOpen}
            onToggleGitHubPane={toggleGitHubPane}
            githubQueueCount={githubQueue.length}
            reportOpen={reportOpen}
            onToggleReport={() => setReportOpen((v) => !v)}
          />
        )}
        <div className="app-main-calendar">
          {view !== "month" ? (
            <WeekGrid
              store={store}
              allDayStore={allDayStore}
              taskStore={taskStore}
              githubStore={githubStore}
              githubActivity={activityVisible ? githubActivity : []}
              githubCiRuns={ciVisible ? githubCiRuns : []}
              plannedStore={plannedStore}
              onDropWorkItem={onDropWorkItem}
              onMovePlannedBlock={onMovePlannedBlock}
              onDeletePlannedBlock={onDeletePlannedBlock}
              timeEntryStore={timeEntryStore}
              onStartTimer={onStartTimer}
              onStopTimer={onStopTimer}
              weekStart={timelineStart}
              dayCount={dayCount}
              timeZone={timeZone}
              onPersist={handlePersist}
              onRequestMoveConfirm={handleRequestMoveConfirm}
              visibleCalendarKeys={visibleCalendarKeys}
              calendarLookup={calendarLookup}
              onDelete={handleDeleteOccurrence}
              onSaveEdit={handleEditSave}
              onSaveAllDayEdit={handleEditSave}
              onRsvp={handleRsvp}
              onAllDayRsvp={handleRsvp}
              writeTarget={defaultWriteTarget}
              onCreateEvent={handleCreate}
              onToggleTask={handleToggleTask}
              hiddenTaskListKeys={hiddenTaskLists}
              declinedVisibility={declinedVisibility}
              // モバイル対応フェーズ2: 狭幅では空き領域からの新規作成を長押し起点にする
              // (縦スクロールとの競合を避けるため。DayColumn.tsx 参照)
              longPressCreate={isNarrow}
              // スマホでのスワイプ日付移動(同フェーズ増分、2026-07-22)。WeekGrid.tsx 側で
              // longPressCreate(=isNarrow)かつ非アニメーション中のときだけ実際に有効化される
              onSwipeNavigate={handleSwipeNavigate}
              // 時間軸ズーム(2026-07-25)。WeekGrid が --hour-height と context の出口になる
              hourHeight={hourHeight}
              onHourHeightChange={handleHourHeightChange}
            />
          ) : (
            <MonthView
              store={store}
              allDayStore={allDayStore}
              monthCursor={monthCursor}
              timeZone={timeZone}
              visibleCalendarKeys={visibleCalendarKeys}
              calendarLookup={calendarLookup}
              onDelete={handleDeleteOccurrence}
              onSaveEdit={handleEditSave}
              onSaveAllDayEdit={handleEditSave}
              onRsvp={handleRsvp}
              onAllDayRsvp={handleRsvp}
              writeTarget={defaultWriteTarget}
              onCreateEvent={handleCreate}
              onNavigateToDay={handleNavigateToDay}
              declinedVisibility={declinedVisibility}
            />
          )}
          {moveConfirm && (
            <MoveConfirmDialog
              title={moveConfirm.updated.title}
              previous={moveConfirm.previous}
              updated={moveConfirm.updated}
              timeZone={timeZone}
              onConfirm={handleConfirmMove}
              onCancel={handleCancelMove}
            />
          )}
          {initIndicator.visible && (
            <div
              className={
                initIndicator.fading ? "init-overlay masu-indicator--fading" : "init-overlay"
              }
            >
              <MasuIndicator size="md" />
            </div>
          )}
        </div>
        {/*
         * GitHub 情報ペイン(GitHubPane、増分1)。overlay モードは position: fixed の backdrop で
         * グリッド上に被さるため、マウント位置自体は .app-main 内のどこでもよい(flex レイアウトの
         * 影響を受けない)。docked モードは逆に .app-main-calendar と並ぶ通常の flex アイテムとして
         * 振る舞う必要があるため、旧 WorkQueueDrawer のように </main> の外側に別マウントするのではなく
         * ここ(.app-main の直接の子)に1箇所だけ置く。
         */}
        {paneOpen && me.github && (
          <GitHubPane
            mode={resolvedPaneMode}
            onModeChange={setPaneMode}
            onClose={() => setPaneOpen(false)}
            disableModeToggle={isNarrow}
            items={githubQueue}
            loading={queueLoading}
            authExpired={queueAuthExpired}
            onRefresh={fetchGithubQueue}
            onReconnect={() => {
              window.location.href = "/auth/github/login";
            }}
            onDragStart={() => setPaneOpen(false)}
            // 実績(実行中タイマー・手動記録・履歴・詳細レポート導線)。旧 WorkLogModal へ
            // 渡していたものをそのままペインへ配線し直した(2026-07-25)。needsActualsData に
            // paneOpen 経路があるので、開いた時点で reportWorkLogs は取得済み(取得前でも
            // 空配列で描画でき、取得完了で履歴が埋まる)。
            workLogs={reportWorkLogs}
            plannedBlocks={reportPlannedBlocks}
            timeEntries={reportTimeEntries}
            nowMs={timerNowMs}
            onStartTimer={onStartTimer}
            onStopTimer={onStopTimer}
            timeZone={timeZone}
            onCreateWorkLog={handleCreateWorkLog}
            onUpdateWorkLog={handleUpdateWorkLog}
            onDeleteWorkLog={handleDeleteWorkLog}
            fetchRepos={fetchReposForPane}
            fetchRepoIssues={fetchRepoIssuesForPane}
            // 詳細レポートはモーダルのまま維持。ペインは開いたままでよい(docked なら併存、
            // overlay でもモーダルが上に載るだけ)。
            onOpenReport={() => setReportOpen(true)}
          />
        )}
      </main>
      {helpOpen && <KeyboardHelpOverlay onClose={() => setHelpOpen(false)} />}
      {/*
       * 設定モーダル(UI 改善、2026-07-22、ユーザー要望「中央配置の設定モーダルへ格上げ」)。
       * 旧 CalendarSettingsPanel はツールバーの .toolbar-account 内にアンカー式ポップオーバーと
       * して描画していたが、中央固定モーダルになったことでアンカー位置計算が不要になり、
       * BlockRulesOverlay/SearchOverlay/TimeReportOverlay と同じくオーバーレイ群として
       * ここ(App 直下)へ移した。開閉制御(panelOpen)自体は変更していない。
       */}
      {panelOpen && me.accounts.length > 0 && (
        <SettingsModal
          accounts={me.accounts}
          onDisconnectAccount={handleDisconnectAccount}
          onAddAccount={() => {
            window.location.href = "/auth/login?add=1";
          }}
          tasksScopeMissingAccounts={tasksScopeMissingAccounts}
          onReconnectAccount={(email) => {
            // 同じ Google アカウントを選び直せば prompt=consent (apps/sync の oauth.ts) で
            // 同意画面が再表示され、2026-07-20 追加の tasks スコープが付与される。
            // 遷移先は「+ アカウントを追加」と同じ /auth/login?add=1 だが、login_hint に
            // 対象アカウントのメールを載せて Google 側でそのアカウントを事前選択させる。
            window.location.href = `/auth/login?add=1&login_hint=${encodeURIComponent(email)}`;
          }}
          onOpenBlockRules={() => {
            setPanelOpen(false);
            setBlockOverlayOpen(true);
          }}
          githubLogin={me.github?.login ?? null}
          githubAuthExpired={githubAuthExpired}
          onConnectGitHub={() => {
            window.location.href = "/auth/github/login";
          }}
          onDisconnectGitHub={handleDisconnectGitHub}
          mcpTokens={mcpTokens}
          onCreateMcpToken={handleCreateMcpToken}
          onDeleteMcpToken={handleDeleteMcpToken}
          onClose={() => setPanelOpen(false)}
        />
      )}
      {blockOverlayOpen && me.connected && (
        <BlockRulesOverlay
          accounts={me.accounts}
          calendarsByAccount={calendarsByAccount}
          rules={blockRules}
          onCreate={handleCreateBlockRule}
          onDelete={handleDeleteBlockRule}
          onClose={() => setBlockOverlayOpen(false)}
        />
      )}
      {searchOpen && (
        <SearchOverlay
          onClose={() => setSearchOpen(false)}
          db={db}
          timeZone={timeZone}
          visibleCalendarKeys={visibleCalendarKeys}
          calendarLookup={calendarLookup}
          onJump={handleSearchJump}
        />
      )}
      {reportOpen && (
        <TimeReportOverlay
          plannedBlocks={reportPlannedBlocks}
          timeEntries={reportTimeEntries}
          workLogs={reportWorkLogs}
          nowMs={timerNowMs}
          estimatedByKey={me.github ? prCommitEstimates : {}}
          estimatesLoading={prCommitEstimatesLoading}
          hookActualByLinkedItem={reportHookActualByLinkedItem}
          onClose={() => setReportOpen(false)}
        />
      )}
    </div>
  );
}

export default App;
