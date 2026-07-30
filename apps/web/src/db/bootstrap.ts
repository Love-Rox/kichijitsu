import { Temporal } from "@js-temporal/polyfill";
import type { IDBPDatabase } from "idb";
import { ensureExpanded, reexpandCurrentWindow } from "../expansion/ensureExpanded";
import { generateDemoSeedData, generateDummyAllDayOccurrences } from "../model/dummy";
import type { Occurrence } from "../model/types";
import type { AllDayStore } from "../store/allDayStore";
import type { GitHubStore } from "../store/githubStore";
import type { OccurrenceStore } from "../store/occurrenceStore";
import type { PlannedStore } from "../store/plannedStore";
import type { TaskStore } from "../store/taskStore";
import type { DeclinedVisibilitySettings } from "../sync/declinedVisibility";
import {
  cleanupDemoData,
  cleanupLegacyGoogleData,
  getAllAllDayOccurrences,
  getAllGitHubItems,
  getAllPlannedBlocks,
  getAllTasks,
  getDeclinedVisibilitySettings,
  getExpansionState,
  getHiddenTaskLists,
  getOccurrencesBetween,
  getOrCreateDeviceId,
  getVisibleCalendars,
  openKichijitsuDB,
  putOccurrences,
  putOverride,
  putSeries,
  type KichijitsuDB,
  type VisibleCalendarsMap,
} from "./database";

/**
 * 起動時の IndexedDB 読み込みシーケンス(リファクタリング フェーズ2 ⑦、2026-07-25 に
 * App.tsx の init effect から移設)。App.tsx 側に残っているのは「マウント時に1回だけ
 * これを呼ぶ useEffect」と cancelled フラグの管理だけになっている。
 *
 * 順序そのものが仕様なので、移設時も1行も入れ替えていない:
 *
 *  1. DB を開く → **deviceId** を取得/生成する(端末ごと syncToken、2026-07-21。
 *     以後の POST /api/sync がこれを body に含めるため、他のどの読み込みより先に確定させる)。
 *  2. レガシー掃除・デモデータ掃除(どちらも冪等、0件なら無音)。
 *  3. 開発時オプトイン (`?demo=1`) のダミーシード(**?demo=1 なら毎起動で投入し直す** ――
 *     2 の掃除と対になっている。2026-07-30、下のコメント参照)。
 *  4. 表示範囲ぶんの展開 (ensureExpanded)。`?demo=1` のときはさらに強制再展開
 *     (reexpandCurrentWindow) を通してから、展開済みウィンドウの occurrences を読む。
 *  5. 終日予定・タスク・GitHub アイテム・予定タイムブロックを**全件**読む
 *     (いずれも展開ウィンドウの概念が無いストア)。
 *  6. 5つのストアへの初回反映を **batch のネストで1回の通知にまとめる**
 *     (初期描画のチラつき防止。下のコメント参照)。
 *  7. 表示設定(選択中カレンダー・タスクリスト非表示集合・不参加表示)を読んでコールバックへ渡す。
 *  8. 最後に onReady(db) ―― App.tsx はここで初めて db state を埋め、
 *     db に依存する各 effect(同期・永続化・GitHub 取得)が動き出す。
 *
 * **キャンセル**は各 await の直後に isCancelled() を挟む形で移設前と同じ位置に残してある
 * (アンマウント後に state を触らないため。5〜7 は「読み込みは続けるが通知だけしない」)。
 *
 * openDatabase / expand / reexpand を差し替え可能にしてあるのはテストのため ―― openKichijitsuDB は
 * プロセス内で1接続にメモ化され、ensureExpanded/reexpandCurrentWindow は Worker を起こすので、そのままでは
 * fake-indexeddb 上の単体テストに乗らない(db/database.test.ts と同じ事情)。
 * 本番の呼び出し側 (App.tsx) は既定値のまま何も渡さない。
 */
export interface BootstrapOptions {
  /** 初回反映先の5ストア。App.tsx が useMemo で1個ずつ作っているものをそのまま渡す */
  stores: {
    store: OccurrenceStore;
    allDayStore: AllDayStore;
    taskStore: TaskStore;
    githubStore: GitHubStore;
    plannedStore: PlannedStore;
  };
  /**
   * 起動直後に展開しておきたい表示範囲 (epoch ms)。呼び出し側がマウント時点の
   * view/monthCursor/timelineStart/dayCount から計算して渡す ―― 移設前はこの計算が
   * 掃除・シードの後に置かれていたが、いずれもマウント時に固定された値なので
   * 計算位置は結果に影響しない
   */
  initialRange: { fromMs: number; toMs: number };
  /** ダミーシード生成に使うタイムゾーン (Temporal.Now.timeZoneId()) */
  timeZone: string;
  /** ダミーシードを投入してよいか (App.tsx の DEMO_SEED_ENABLED)。通常起動では常に false */
  demoSeedEnabled: boolean;
  /** アンマウント済みかどうか。true になった後は state を触らない */
  isCancelled: () => boolean;
  /** この端末の deviceId。同期側 (hooks/useCalendarSync.ts の setDeviceId) に渡す */
  onDeviceId: (deviceId: string) => void;
  /** IndexedDB に保存されていた選択中カレンダー(prev 優先マージは受け側の責務) */
  onVisibleCalendars: (stored: VisibleCalendarsMap) => void;
  /** IndexedDB に保存されていたタスクリスト非表示集合 */
  onHiddenTaskLists: (stored: ReadonlySet<string>) => void;
  /** IndexedDB に保存されていた「不参加を表示」設定 */
  onDeclinedVisibility: (stored: DeclinedVisibilitySettings) => void;
  /** 全て終わった合図。App.tsx はここで db state を埋める(= 初回ロード表示が消える) */
  onReady: (db: IDBPDatabase<KichijitsuDB>) => void;
  /** DB を開く。既定は openKichijitsuDB(テスト用の差し替え口) */
  openDatabase?: () => Promise<IDBPDatabase<KichijitsuDB>>;
  /** 表示範囲ぶんの展開。既定は expansion/ensureExpanded(テスト用の差し替え口) */
  expand?: (
    db: IDBPDatabase<KichijitsuDB>,
    store: OccurrenceStore,
    fromMs: number,
    toMs: number,
  ) => Promise<void>;
  /**
   * 保存済みウィンドウ全体の強制再展開。既定は expansion/ensureExpanded の
   * reexpandCurrentWindow(expand と同じくテスト用の差し替え口)。
   * デモシード後にしか呼ばれない ―― 理由は下の呼び出し箇所のコメント参照
   */
  reexpand?: (db: IDBPDatabase<KichijitsuDB>, store: OccurrenceStore) => Promise<void>;
}

export async function bootstrapDatabase({
  stores: { store, allDayStore, taskStore, githubStore, plannedStore },
  initialRange,
  timeZone,
  demoSeedEnabled,
  isCancelled,
  onDeviceId,
  onVisibleCalendars,
  onHiddenTaskLists,
  onDeclinedVisibility,
  onReady,
  openDatabase = openKichijitsuDB,
  expand = ensureExpanded,
  reexpand = reexpandCurrentWindow,
}: BootstrapOptions): Promise<void> {
  const database = await openDatabase();
  if (isCancelled()) return;

  // 端末ごと syncToken (2026-07-21): db を開いた直後に deviceId を取得/生成しておく。
  // 以後の syncCalendarOnce (POST /api/sync) がこれを body に含める
  const deviceId = await getOrCreateDeviceId(database);
  if (isCancelled()) return;
  onDeviceId(deviceId);

  // レガシー掃除(一回きり・冪等): ID スコープ化 (2026-07-19) 以前の旧形式
  // Google データ (`g:<eventId>`、accountId/calendarId フィールドなし) は
  // 現行のフィルタにマッチしない不可視の残骸なので削除する。0件なら何も出さない
  const legacyCleanup = await cleanupLegacyGoogleData(database);
  if (isCancelled()) return;
  const legacyTotal =
    legacyCleanup.seriesRemoved + legacyCleanup.occurrencesRemoved + legacyCleanup.overridesRemoved;
  if (legacyTotal > 0) {
    console.info(
      `kichijitsu: legacy Google data cleanup removed ${legacyTotal} record(s) ` +
        `(series=${legacyCleanup.seriesRemoved}, occurrences=${legacyCleanup.occurrencesRemoved}, ` +
        `overrides=${legacyCleanup.overridesRemoved})`,
    );
  }

  // デモ/シードデータの一回きりクリーンアップ (実データ運用への移行、2026-07-20):
  // demoSeedEnabled が false の通常起動では二度とシードされないが、過去に
  // シード済みだった環境の残骸を掃除する。cleanupLegacyGoogleData と同じ流儀で
  // 起動のたびに呼んでよい(冪等・0件なら何も出さない)
  const demoCleanup = await cleanupDemoData(database);
  if (isCancelled()) return;
  const demoTotal =
    demoCleanup.seriesRemoved + demoCleanup.occurrencesRemoved + demoCleanup.overridesRemoved;
  if (demoTotal > 0) {
    console.info(
      `kichijitsu: demo data cleanup removed ${demoTotal} record(s) ` +
        `(series=${demoCleanup.seriesRemoved}, occurrences=${demoCleanup.occurrencesRemoved}, ` +
        `overrides=${demoCleanup.overridesRemoved})`,
    );
  }

  // ダミーシード投入は開発時の明示的なオプトイン (?demo=1) のときだけ
  // (App.tsx の DEMO_SEED_ENABLED 参照)。実データ運用では絶対に自動投入しない。
  //
  // **?demo=1 のときは毎起動で投入し直す** (2026-07-30 の修正、旧: countSeries()===0 の
  // ときだけ)。直前の cleanupDemoData がデモの series/override/occurrence を必ず消すので、
  // 「一度入れたら二度目は入れない」条件を付けても意味が無く ―― むしろ「Google 連携済みの
  // 環境で ?demo=1 を付けると、series が0件でないのでデモが1件も入らない」という
  // 分かりにくい分岐を生んでいた。掃除の直後に入れ直すので重複も生まれない
  // (何度リロードしても同じ見え方になる、という要件そのもの)
  if (demoSeedEnabled) {
    const demo = generateDemoSeedData(Temporal.Now.plainDateISO(), timeZone, Date.now());
    await putSeries(database, demo.series);
    await Promise.all(demo.overrides.map((o) => putOverride(database, o)));
    await putOccurrences(database, demo.occurrences);
  }
  if (isCancelled()) return;

  await expand(database, store, initialRange.fromMs, initialRange.toMs);
  if (isCancelled()) return;

  // デモの series を入れ直したら、展開もやり直す (2026-07-30)。
  //
  // なぜ expand だけでは足りないか: ensureExpanded は「表示範囲が展開済みウィンドウの境界に
  // 近づいたときだけ広げる」増分ポリシーなので、2回目以降の起動では expansionState が既に
  // 保存されているぶん何もせずに返る。すると上の cleanupDemoData が消したシリーズ由来の
  // occurrence が復活せず、**単発予定と終日予定だけが出て繰り返し予定が消えた**画面になる
  // (「?demo=1 は初回起動だけ正常」というバグの正体、報告 2026-07-30)。
  //
  // series の定義が変わったのに展開結果が古い、という状況は sync 適用後と同じなので、
  // 同じ道具で直す ―― reexpandCurrentWindow は保存済みウィンドウ全体を無条件に再展開し、
  // 現存する series 由来の古い occurrence を先に消してから書き直す。
  // デモ以外(実データ運用)では絶対に呼ばない: 起動のたびに全 series を再展開するのは
  // 増分ポリシーの放棄であり、通常起動でそこまでする理由が無い
  if (demoSeedEnabled) {
    await reexpand(database, store);
    if (isCancelled()) return;
  }

  const state = await getExpansionState(database);
  let all: Occurrence[] | undefined;
  if (state) {
    all = await getOccurrencesBetween(database, state.expandedFromMs, state.expandedToMs);
  }

  // 終日予定 (フェーズ5): 展開ウィンドウの概念が無いため全件を丸ごとロードする
  const storedAllDays = await getAllAllDayOccurrences(database);
  // デモ終日予定 (2026-07-28、?demo=1 のときだけ): 「終日の不在をどこに描くか」の設定を
  // 目視確認できるよう、終日の不在を含むダミーを混ぜる。上の series/occurrences と違い
  // IndexedDB には書かず、このメモリ上のストアにだけ載せる ―― デモ用データが実データの
  // データベースに残らないようにするため(cleanupDemoData の掃除対象にもならない)
  const allDays = demoSeedEnabled
    ? [...storedAllDays, ...generateDummyAllDayOccurrences(Temporal.Now.plainDateISO())]
    : storedAllDays;
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
  // 読み込むことはしない(timeEntryStore は開区間の射影キャッシュとして hooks/useTimers.ts が満たす)。

  // occurrences・終日予定・タスク・GitHub アイテム・予定タイムブロックの
  // 初回反映を1回の通知にまとめ、初期描画のチラつきを防ぐ。
  // ネストの意味: 5つの load をすべてのストアが batch 中の状態で行うことで、
  // 「occurrences だけ入って終日予定が空」のような中間状態が一度も描画されない
  // (各ストアは自分の batch を抜けるときに1回だけ通知する)。順序も変えないこと。
  if (!isCancelled()) {
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

  // 選択中カレンダーの読み込み。prev 優先マージ(「一生 primary が選ばれず {} が永続化される」
  // 既知バグの修正)と「読み込み完了」フラグの立て方は受け側
  // (hooks/useGoogleAccounts.ts の loadStoredVisibleCalendars) にあるので、ここは読んで渡すだけ
  const storedVisible = await getVisibleCalendars(database);
  if (!isCancelled()) onVisibleCalendars(storedVisible);

  // タスクリスト表示 ON/OFF(左ペイン増分2): サーバー同期が無くこの端末の IndexedDB が
  // 唯一の正なので、visibleCalendars のような server/prev マージは不要 ―― 素直に読み込むだけ
  const storedHiddenTaskLists = await getHiddenTaskLists(database);
  if (!isCancelled()) onHiddenTaskLists(storedHiddenTaskLists);

  // 「不参加を表示」設定(参加ステータス表示): hiddenTaskLists と同じくこの端末の
  // IndexedDB が唯一の正なので、素直に読み込むだけでよい
  const storedDeclinedVisibility = await getDeclinedVisibilitySettings(database);
  if (!isCancelled()) onDeclinedVisibility(storedDeclinedVisibility);

  if (!isCancelled()) onReady(database);
}
