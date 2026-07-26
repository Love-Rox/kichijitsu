import { useCallback, useEffect, useMemo, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import type { IDBPDatabase } from "idb";
import { hookActualByLinkedItem } from "./sync/hookActual";
import { deleteJson } from "./sync/httpJson";
import { DEFAULT_HOUR_HEIGHT, normalizeHourHeight } from "./layout/gridMetrics";
import { WeekGrid } from "./components/WeekGrid";
import { MasuIndicator } from "./components/MasuIndicator";
import { AppToolbar } from "./components/AppToolbar";
import { AppOverlays } from "./components/AppOverlays";
import { MonthView } from "./components/MonthView";
import { MoveConfirmDialog } from "./components/MoveConfirmDialog";
import { CalendarPane } from "./components/CalendarPane";
import { GitHubPane } from "./components/GitHubPane";
import type { CalendarInfo } from "./components/EventBlock";
import { useBlockRules } from "./hooks/useBlockRules";
import { useCalendarSync } from "./hooks/useCalendarSync";
import { useEventMutations } from "./hooks/useEventMutations";
import { useGitHubData, useGitHubPrCommitEstimates } from "./hooks/useGitHubData";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useGoogleAccounts } from "./hooks/useGoogleAccounts";
import { useMasuVisible } from "./hooks/useMasuVisible";
import { useMcpTokens } from "./hooks/useMcpTokens";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useOffline } from "./hooks/useOffline";
import { usePlannedBlockHandlers } from "./hooks/usePlannedBlockHandlers";
import { useTimelineNavigation } from "./hooks/useTimelineNavigation";
import { useTimers } from "./hooks/useTimers";
import { useWorkLogs } from "./hooks/useWorkLogs";
import { OccurrenceStore } from "./store/occurrenceStore";
import { AllDayStore } from "./store/allDayStore";
import { TaskStore } from "./store/taskStore";
import { GitHubStore } from "./store/githubStore";
import { PlannedStore, useAllPlannedBlocks } from "./store/plannedStore";
import { TimeEntryStore, useTimeEntries } from "./store/timeEntryStore";
import { bootstrapDatabase } from "./db/bootstrap";
import type { KichijitsuDB } from "./db/database";
import { ensureExpanded } from "./expansion/ensureExpanded";
import { resolveJumpDate, type SearchJumpTarget } from "./search/searchOccurrences";
import { monthGridRangeMs } from "./layout/monthGrid";
import {
  effectivePaneMode,
  isPaneMode,
  shouldCloseOtherPaneOnOpen,
  type PaneMode,
} from "./layout/paneMode";
import { calendarKey } from "./layout/keys";
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

  // マルチアカウント対応 (2026-07-19) の状態(me / カレンダー一覧 / 選択中カレンダー /
  // タスクリスト一覧 / tasks スコープ未付与アカウント / タスクリスト非表示集合 /
  // 不参加表示設定)とその取得・永続化・連携解除は hooks/useGoogleAccounts.ts へ移した
  // (リファクタリング フェーズ2 ⑥、2026-07-25。下の useGoogleAccounts 呼び出し参照)。
  // 同期(POST /api/sync)側は hooks/useCalendarSync.ts で、両者を繋ぐグルーだけがここに残る。
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
  // (リファクタリング フェーズ2 ⑤、2026-07-25。下の useWorkLogs 呼び出し参照)。
  //
  // ここに無くなった残りの state / ref の行き先(いずれも 2026-07-25 のフェーズ2):
  //  - 保存失敗のフラッシュ表示 (saveError)・移動確認ダイアログ (moveConfirm) →
  //    それを立てる変更系ハンドラごと hooks/useEventMutations.ts(④)
  //  - 同期状態 (syncStatus) と同期の直列化・自動同期の一回きり判定の ref
  //    (syncSchedulerRef / autoSyncedRef / autoSyncedTaskListsRef / deviceIdRef) →
  //    hooks/useCalendarSync.ts(⑥)
  //  - 一覧のフェッチ済み判定と PUT の pending 追跡の ref (fetchedAccountsRef /
  //    fetchInFlightRef / fetchedTaskAccountsRef / visibleCalendarsLoadedRef /
  //    pendingVisiblePutsRef / visibleCalendarsRef) → hooks/useGoogleAccounts.ts(⑥)

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

  // POST /api/watch(push 通知登録)と PUT /api/visible-calendars(カレンダー選択の
  // 端末間同期・lost update 防止つき)は、それを使うトグル/一覧取得ごと
  // hooks/useGoogleAccounts.ts へ移した(フェーズ2 ⑥)。

  // 初回ロード中(db==null, store に最初のデータがまだ入っていない)かどうか。
  // グリッド中央に枡インジケーターをオーバーレイし、初期化完了で消す
  const initializing = db === null;
  const initIndicator = useMasuVisible(initializing);

  /*
   * 起動時の IndexedDB 読み込み(DB を開く → deviceId → レガシー/デモ掃除 → 表示範囲ぶんの
   * 展開 → 各ストアへの初回反映 → 表示設定の読み込み → db state の確定)は db/bootstrap.ts へ
   * 移した(リファクタリング フェーズ2 ⑦、2026-07-25)。順序そのものが仕様なので、
   * batch のネスト(初期描画のチラつき防止)も含めてあちらで固めてテストを書いてある。
   * ここに残るのは「マウント時に1回だけ呼ぶ」配線と cancelled フラグだけ。
   *
   * このコールバック群(setDeviceId / loadStored*)は宣言順ではこの effect より後ろにある
   * フックの返り値だが、effect の本体はレンダー完了後に実行されるので参照して問題ない
   * (依存配列に置くとレンダー中に評価されて TDZ になるため、それは避ける ―― 依存は
   * 従来どおり空のまま、下の eslint-disable も維持する)。
   */
  useEffect(() => {
    let cancelled = false;

    // 表示範囲はマウント時点の view/monthCursor/timelineStart/dayCount で固定してよい
    // (この effect は初回マウント時にのみ実行される)
    const initialRange =
      view === "month"
        ? monthGridRangeMs(monthCursor, timeZone)
        : timelineRangeMs(timelineStart, dayCount, timeZone);

    bootstrapDatabase({
      stores: { store, allDayStore, taskStore, githubStore, plannedStore },
      initialRange,
      timeZone,
      demoSeedEnabled: DEMO_SEED_ENABLED,
      isCancelled: () => cancelled,
      onDeviceId: setDeviceId,
      onVisibleCalendars: loadStoredVisibleCalendars,
      onHiddenTaskLists: loadStoredHiddenTaskLists,
      onDeclinedVisibility: loadStoredDeclinedVisibility,
      onReady: setDb,
    }).catch((err) => {
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

  /**
   * Google 連携アカウントと表示設定(hooks/useGoogleAccounts.ts)。GET /api/me の再取得
   * (起動時・online 復帰時)、カレンダー/タスクリスト一覧の取得、選択状態のサーバー保存
   * (PUT /api/visible-calendars、lost update 防止つき)と IndexedDB 永続化、アカウント
   * 連携解除がすべて入っている(リファクタリング フェーズ2 ⑥、2026-07-25)。
   *
   * 呼び出し位置: `me` を下の useBlockRules / useGitHubData が引数に取るため、ここより
   * 後ろには置けない(フックの引数はレンダー中に評価される)。移設前は永続化 effect と
   * 一覧取得 effect が useGitHubData の後に登録されていたが、それらは初回マウント時には
   * すべてガードで空振りし、GitHub 系 effect と読み書きする state も分かれているため
   * 登録順の入れ替えで挙動は変わらない(フック側のコメントに詳細)。
   * 返り値は JSX 側の既存の名前に別名で受けて、呼び出し箇所を一切変えずに済ませている。
   */
  const {
    me,
    calendarsByAccount,
    visibleCalendars,
    taskListsByAccount,
    tasksScopeMissingAccounts,
    hiddenTaskLists,
    declinedVisibility,
    loadStoredVisibleCalendars,
    loadStoredHiddenTaskLists,
    loadStoredDeclinedVisibility,
    toggleCalendarVisibility,
    toggleTaskList: handleToggleTaskList,
    toggleShowDeclined: handleToggleShowDeclined,
    toggleKeepOrganizerDeclined: handleToggleKeepOrganizerDeclined,
    disconnectAccount,
    clearGitHubConnection,
  } = useGoogleAccounts({ db, store, allDayStore, taskStore, panelOpen, checkedFetch });

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

  // MCP トークン一覧 + 発行/失効(hooks/useMcpTokens.ts)。取得タイミング(設定パネルが
  // 開いた瞬間だけ)も含めてフック側にあるので、ここは配線だけ
  const {
    mcpTokens,
    createMcpToken: handleCreateMcpToken,
    deleteMcpToken: handleDeleteMcpToken,
  } = useMcpTokens({ panelOpen, checkedFetch });

  /**
   * Google カレンダー/タスクの同期(hooks/useCalendarSync.ts)。1カレンダー単位の同期
   * (POST /api/sync、syncScheduler による直列化つき)・タスクリストの同期・手動/起動時の
   * 一巡同期 (runSync) と同期バックフィル・SSE (hello/changed) の配線・新規予定の既定の
   * 書き込み先 (defaultWriteTarget) が入っている(リファクタリング フェーズ2 ⑥、2026-07-25)。
   *
   * 表示状態は useGoogleAccounts から**一方向に**渡すだけで、逆向き(「カレンダーを選んだら
   * そのカレンダーを即同期する」)はこの下の handleToggleCalendar が繋ぐ ―― 相互参照する
   * フックを作らず、循環は配線層に置くという判断。
   *
   * 呼び出し位置は移設前の syncCalendarOnce 宣言位置に揃えてある(このフックが登録する
   * effect は SSE 接続 → 起動時の自動同期 → タスクリストの初回同期の3本で、useMcpTokens の
   * 後・useEventMutations の前という登録順を保つため)。
   */
  const {
    syncStatus,
    defaultWriteTarget,
    runSync,
    syncCalendar,
    setDeviceId,
    forgetAutoSyncedTaskLists,
  } = useCalendarSync({
    db,
    store,
    allDayStore,
    taskStore,
    accounts: me.accounts,
    calendarsByAccount,
    visibleCalendars,
    taskListsByAccount,
    // sync が対応しているバックフィル世代 (2026-07-25)。web だけ先にデプロイされた状態で
    // 「サーバーがまだ返さないフィールド」をバックフィル済みと記録してしまう事故を防ぐため、
    // useCalendarSync が min(自世代, これ) までしか記録しない
    serverSyncBackfillVersion: me.syncBackfillVersion,
    checkedFetch,
    markOnline,
    markOffline,
  });

  // 同期中の枡インジケーター。syncStatus が useCalendarSync の返り値になったため、
  // initIndicator (初回ロード) と並べて上に置くことはできず(フックの引数はレンダー中に
  // 評価されるため)ここへ下げてある。挙動は同じ(useMasuVisible は自身の active だけを見る)
  const syncIndicator = useMasuVisible(syncStatus === "syncing");

  /*
   * 左ペイン(CalendarPane、カレンダーナビゲーション増分1)でのカレンダー表示チェック操作。
   * useGoogleAccounts(表示状態)と useCalendarSync(同期)を繋ぐ**グルー**で、意図的に
   * App.tsx に残してある ―― トグルは選択状態を変えるだけでなく「選択した瞬間にその
   * カレンダーだけ同期する」ため、フックの中に置くと両者が相互参照してしまう
   * (リファクタリング フェーズ2 ⑥、2026-07-25)。
   *
   * 順序も移設前のまま: state の楽観更新 → POST /api/watch → PUT /api/visible-calendars
   * (ここまで toggleCalendarVisibility)→ db が無ければ打ち切り → 選択時のみ即時同期。
   */
  const handleToggleCalendar = useCallback(
    (accountId: string, calendarId: string, nextChecked: boolean) => {
      toggleCalendarVisibility(accountId, calendarId, nextChecked);

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
    [db, calendarsByAccount, syncCalendar, toggleCalendarVisibility],
  );

  /*
   * アカウント単位の連携解除。本体(DELETE /api/account → 状態の畳み込み → ローカルデータ
   * 削除)は useGoogleAccounts にあり、ここは同期側の既知集合(自動同期済みタスクリスト、
   * useCalendarSync)の掃除関数を渡すだけのグルー。移設前はその掃除が畳み込みとローカル
   * データ削除の**間**にあったため、位置を変えずに済むよう引数で渡す形にしている
   * (handleToggleCalendar と同じ「循環は配線層に置く」方針)。
   * 失敗は呼び出し元(パネルの行UI)が catch して表示するので、reject はそのまま伝播する。
   */
  const handleDisconnectAccount = useCallback(
    (accountId: string) => disconnectAccount(accountId, forgetAutoSyncedTaskLists),
    [disconnectAccount, forgetAutoSyncedTaskLists],
  );

  // GitHub 連携解除 (docs/github-integration.md フェーズ①Part B)。DELETE /api/github で
  // サーバー側の github_connections 行を消し、成功したら me.github を null に戻して
  // ローカルの GitHub アイテムも畳む(IndexedDB/store の両方)。失敗時は呼び出し元
  // (設定パネルのインライン確認 UI、handleDisconnectAccount と同じ流儀)が catch して表示する
  const handleDisconnectGitHub = useCallback(async () => {
    await deleteJson(checkedFetch, "/api/github");
    // me.github を null に戻すのは useGoogleAccounts 側(me の持ち主)、GitHub 由来の
    // ローカルデータ(作業キュー・実績/CI オーバーレイ・再連携フラグの state と、
    // IndexedDB/store のアイテムレーン)を畳むのは useGitHubData 側の責務。
    // この2つのフックを繋ぐグルーなので handleToggleCalendar と同じくここに残してある
    clearGitHubConnection();
    await clearGitHubData();
  }, [checkedFetch, clearGitHubConnection, clearGitHubData]);

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
      <AppToolbar
        view={view}
        isNarrow={isNarrow}
        goToPrev={goToPrev}
        goToNext={goToNext}
        goToToday={goToToday}
        switchView={switchView}
        openSearch={openSearch}
        hourHeight={hourHeight}
        handleHourHeightChange={handleHourHeightChange}
        monthCursor={monthCursor}
        timelineStart={timelineStart}
        offline={offline}
        me={me}
        panelOpen={panelOpen}
        setPanelOpen={setPanelOpen}
        runSync={runSync}
        syncStatus={syncStatus}
        syncIndicator={syncIndicator}
        saveError={saveError}
        leftPaneOpen={leftPaneOpen}
        toggleLeftPane={toggleLeftPane}
        paneOpen={paneOpen}
        toggleGitHubPane={toggleGitHubPane}
        runningTimeEntries={runningTimeEntries}
        timerNowMs={timerNowMs}
        onStopTimer={onStopTimer}
        setHelpOpen={setHelpOpen}
      />
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
      <AppOverlays
        me={me}
        helpOpen={helpOpen}
        setHelpOpen={setHelpOpen}
        panelOpen={panelOpen}
        setPanelOpen={setPanelOpen}
        handleDisconnectAccount={handleDisconnectAccount}
        tasksScopeMissingAccounts={tasksScopeMissingAccounts}
        setBlockOverlayOpen={setBlockOverlayOpen}
        githubAuthExpired={githubAuthExpired}
        handleDisconnectGitHub={handleDisconnectGitHub}
        mcpTokens={mcpTokens}
        handleCreateMcpToken={handleCreateMcpToken}
        handleDeleteMcpToken={handleDeleteMcpToken}
        blockOverlayOpen={blockOverlayOpen}
        calendarsByAccount={calendarsByAccount}
        blockRules={blockRules}
        handleCreateBlockRule={handleCreateBlockRule}
        handleDeleteBlockRule={handleDeleteBlockRule}
        searchOpen={searchOpen}
        setSearchOpen={setSearchOpen}
        db={db}
        timeZone={timeZone}
        visibleCalendarKeys={visibleCalendarKeys}
        calendarLookup={calendarLookup}
        handleSearchJump={handleSearchJump}
        reportOpen={reportOpen}
        setReportOpen={setReportOpen}
        reportPlannedBlocks={reportPlannedBlocks}
        reportTimeEntries={reportTimeEntries}
        reportWorkLogs={reportWorkLogs}
        timerNowMs={timerNowMs}
        prCommitEstimates={prCommitEstimates}
        prCommitEstimatesLoading={prCommitEstimatesLoading}
        reportHookActualByLinkedItem={reportHookActualByLinkedItem}
      />
    </div>
  );
}

export default App;
