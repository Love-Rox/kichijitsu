import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDBPDatabase } from "idb";
import type {
  AccountDTO,
  CalendarListEntryDTO,
  SyncRequest,
  SyncResponse,
  TaskListDTO,
  TasksSyncRequest,
  TasksSyncResponse,
} from "@kichijitsu/shared";
import {
  CURRENT_SYNC_BACKFILL_VERSION,
  getSyncBackfillVersion,
  setSyncBackfillVersion,
  type KichijitsuDB,
  type VisibleCalendarsMap,
} from "../db/database";
import { calendarKey, taskListKey } from "../layout/keys";
import type { AllDayStore } from "../store/allDayStore";
import type { OccurrenceStore } from "../store/occurrenceStore";
import type { TaskStore } from "../store/taskStore";
import { applySyncResponse } from "../sync/applySync";
import { applyTasksSyncResponse } from "../sync/applyTasksSync";
import { resolveDefaultWriteTarget, type WriteTargetCandidate } from "../sync/eventCreate";
import { sendJson, type CheckedFetch } from "../sync/httpJson";
import { shouldSkipAutoSyncForReauth, type SyncTrigger } from "../sync/reauthSkip";
import {
  decideSyncBackfillTargets,
  excludeReauthPendingTargets,
  resolveEffectiveSyncBackfillVersion,
} from "../sync/syncBackfill";
import { buildSyncRequest } from "../sync/syncRequest";
import { createSyncScheduler } from "../sync/syncScheduler";
import { useServerEvents } from "./useServerEvents";

/**
 * Google カレンダー/タスクの同期をまとめたフック
 * (リファクタリング フェーズ2 ⑥、2026-07-25 に App.tsx から移設)。持っているのは:
 *
 *  - **1カレンダーの同期** (syncCalendar → syncCalendarOnce = POST /api/sync + applySyncResponse)。
 *    同一 (accountId, calendarId) の多重実行は syncSchedulerRef で直列化する。
 *  - **1タスクリストの同期** (syncTaskList = POST /api/tasks/sync、docs/google-tasks.md)。
 *  - **一巡同期** (runSync = 選択中カレンダー + 取得済みタスクリストを並行、手動「同期」ボタンと
 *    起動時の自動同期)と、**同期バックフィル** (runSyncBackfillIfNeeded、forceFull で全同期)、
 *    および**再同期** (runFullResync = 設定モーダルの脱出口。runSync と同じ対象を forceFull で回す)。
 *  - **SSE** (useServerEvents) の hello / changed 配線、および起動時1回の自動同期 effect、
 *    タスクリストが新たに見つかったときの1回だけの自動同期 effect。
 *  - **新規予定の既定の書き込み先** (defaultWriteTarget)。selectedTargets から導くため同居させた。
 *
 * 表示状態(accounts / calendarsByAccount / visibleCalendars / taskListsByAccount)は
 * hooks/useGoogleAccounts.ts が持ち、このフックは**引数として一方向に受け取るだけ**。
 * 「カレンダーを選択したら即そのカレンダーだけ同期する」という逆向きの結線は App.tsx の
 * グルー (handleToggleCalendar) に置いてある ―― フックを相互参照させないための構造。
 *
 * **再認証待ちアカウントの自動同期スキップ** (2026-08-07、本番実測での障害対応。
 * sync/reauthSkip.ts 冒頭のコメント参照)。syncCalendar/syncTaskList/runSync は
 * `trigger: "auto" | "manual"` を**省略不可**で受け取り、「自動経路 かつ そのアカウントが
 * reauthRequired (accounts の AccountDTO.reauthRequired)」のときだけ実際の
 * POST /api/sync・POST /api/tasks/sync を叩かずスキップする (shouldSkipAutoSyncForReauth)。
 * 手動「同期」ボタン・「再同期」は常に trigger: "manual" で、reauthRequired に関わらず
 * 必ず試す ―― 記録が誤っていた場合に利用者が永久に復帰できなくなるのを避けるため。
 * 「省略時は auto」のような既定値を持たせていないのは、新しい呼び出し経路を足すたびに
 * auto/manual のどちらかを意識して選ばせるため (書き忘れが黙って自動スキップ側に
 * 倒れる事故を防ぐ)。
 *
 * runSyncBackfillIfNeeded だけは上のスキップに加えてもう一段構えている
 * (excludeReauthPendingTargets、sync/syncBackfill.ts 参照): 対象からあらかじめ reauth 待ち
 * アカウントを除外し、除外が発生していたらバックフィル版数を記録しない。単に
 * shouldSkipAutoSyncForReauth のスキップ (fulfilled 扱い) に任せると、他が全部成功した時点で
 * 「全成功」と誤認して版数を記録してしまい、そのアカウントが後で再認証されても当該世代の
 * バックフィルを二度と受けられなくなる ―― resolveEffectiveSyncBackfillVersion が警戒している
 * のと同じ「永久に欠ける」事故だったため(2026-08-07、レビュー指摘で追加)。
 *
 * 壊してはいけない点(移設前のコメントから引き継ぎ):
 *  - 起動時の `runSync().then(() => runSyncBackfillIfNeeded())` の**直列性**。並列化すると
 *    通常同期と forceFull 同期が syncScheduler 上で競合する。
 *  - syncSchedulerRef によるカレンダー単位の直列化。
 *  - POST /api/sync 失敗時のメッセージに `(accountId/calendarId)` を残すこと(どのカレンダーが
 *    失敗したか console から読めるようにするため、高レベルの postJson ではなく sendJson を使う)。
 *  - バックフィル版数の記録は**全成功時のみ**(部分的に古いカレンダーを残さない)。
 *
 * 呼び出し位置の制約(App.tsx 側): このフックが登録する effect は3本(SSE 接続 → 起動時の
 * 自動同期 → タスクリストの初回同期)で、移設前と同じ順序・同じ相対位置(useMcpTokens の後、
 * useEventMutations の前)を保つため、App.tsx でも syncCalendarOnce があった場所で呼んでいる。
 */
export interface CalendarSyncController {
  /** ツールバーの同期インジケーター/「同期失敗」表示用 */
  syncStatus: "idle" | "syncing" | "error";
  /**
   * 新規予定 (フェーズ5) のデフォルトの書き込み先: 選択中カレンダーのうち primary が
   * あればそれ、無ければ先頭 (規則は sync/eventCreate.ts 参照)。null なら空き領域
   * クリック/ドラッグでの新規作成自体を無効化する (WeekGrid/DayColumn 側)
   */
  defaultWriteTarget: WriteTargetCandidate | null;
  /**
   * 書き込み先として選べる全候補 (2026-07-29 全項目入力)。defaultWriteTarget と同じ
   * selectedTargets() 由来 ―― 新規作成の詳細フォームで「どのカレンダーに作るか」を
   * 利用者に選ばせるために、既定1件だけでなく一覧も出す。
   */
  writeTargetCandidates: readonly WriteTargetCandidate[];
  /**
   * ツールバーの「同期」ボタンと、起動時の自動同期の両方から呼ばれる共通処理
   * (選択中カレンダー + 取得済みタスクリストを並行同期する)。`trigger` は呼び出し側が必ず
   * 明示する ―― ボタンからは "manual"、起動時 useEffect からは "auto"
   * (sync/reauthSkip.ts 参照。省略不可なのは意図的、このファイル冒頭のコメント参照)
   */
  runSync: (trigger: SyncTrigger) => Promise<void>;
  /**
   * 設定モーダルの「再同期」(2026-07-29、ユーザー要望)。runSync と同じ対象を、
   * カレンダーだけ forceFull で回す全件取り直し。失敗したら reject する
   * (呼び出し元の2段階確認 UI が「失敗」を出す) ―― runSync が握りつぶすのと違うのは、
   * 利用者が明示的に押した操作で、結果を伝えないと押し直す判断ができないため。
   * 常に利用者が押した経路なので trigger は内部で "manual" 固定 ―― 外から渡す必要はない
   */
  runFullResync: () => Promise<void>;
  /**
   * 1カレンダーの同期(直列化つき)。App.tsx のグルーが「カレンダーを新規選択した直後の
   * 即時同期」で呼ぶ。runSync / SSE / バックフィルからも同じ経路を通る。
   * `trigger` は省略不可 (sync/reauthSkip.ts、このファイル冒頭のコメント参照) ――
   * 呼び出し元ごとに auto/manual を明示させる
   */
  syncCalendar: (
    accountId: string,
    calendarId: string,
    defaultColor: string | undefined,
    forceFull: boolean,
    trigger: SyncTrigger,
  ) => Promise<void>;
  /**
   * 端末ごと syncToken (2026-07-21) の deviceId を渡す。db/bootstrap.ts が DB を開いた直後に
   * 1回だけ呼ぶ(ref に入れるだけなので再レンダーは起きない)
   */
  setDeviceId: (deviceId: string) => void;
  /**
   * そのアカウントの「自動同期済みタスクリスト」既知集合を忘れる。アカウント連携解除の
   * シーケンス(hooks/useGoogleAccounts.ts の disconnectAccount)の途中から呼ばれる
   */
  forgetAutoSyncedTaskLists: (accountId: string) => void;
}

/** 同期対象の (accountId, taskListId) ペア(docs/google-tasks.md)。selectedTargets のタスク版 */
interface TaskListTarget {
  accountId: string;
  taskListId: string;
}

/**
 * @param db 起動シーケンス完了までは null(同期は何もしない)
 * @param markOnline SSE 接続確立時に呼ぶ(hooks/useOffline.ts)
 * @param markOffline SSE エラー時に呼ぶ(同上)
 */
export function useCalendarSync({
  db,
  store,
  allDayStore,
  taskStore,
  accounts,
  calendarsByAccount,
  visibleCalendars,
  taskListsByAccount,
  serverSyncBackfillVersion,
  checkedFetch,
  markOnline,
  markOffline,
}: {
  db: IDBPDatabase<KichijitsuDB> | null;
  store: OccurrenceStore;
  allDayStore: AllDayStore;
  taskStore: TaskStore;
  accounts: AccountDTO[];
  calendarsByAccount: Record<string, CalendarListEntryDTO[]>;
  visibleCalendars: VisibleCalendarsMap;
  taskListsByAccount: Record<string, TaskListDTO[]>;
  /**
   * GET /api/me の MeResponse.syncBackfillVersion(= sync が対応しているバックフィル世代)。
   * 未取得/旧サーバーでは undefined。バックフィル完了として記録する世代の上限に使う
   * (runSyncBackfillIfNeeded、2026-07-25)
   */
  serverSyncBackfillVersion: number | undefined;
  checkedFetch: CheckedFetch;
  markOnline: () => void;
  markOffline: () => void;
}): CalendarSyncController {
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "error">("idle");
  const autoSyncedRef = useRef(false);
  // 新規に見つかった (accountId, taskListId) を一度だけ自動同期するための既知集合
  // (`${accountId}:${taskListId}` キー、runSync の手動同期とは別に初回表示を早める用途)
  const autoSyncedTaskListsRef = useRef(new Set<string>());
  // syncCalendar (増分同期・全同期) の同一 (accountId, calendarId) 多重実行ガード (2026-07-21)。
  // SSE hello/changed・起動時 runSync・カレンダー選択トグルなど複数経路から await なしで
  // 多重に発火しうるため、キー単位で直列化する (sync/syncScheduler.ts 参照)
  const syncSchedulerRef = useRef(createSyncScheduler());
  // 端末ごと syncToken (2026-07-21): この端末の deviceId (IndexedDB meta に永続化、
  // db/database.ts の getOrCreateDeviceId 参照)。起動シーケンス (db/bootstrap.ts) が db を
  // 開いた直後に setDeviceId で入れる。POST /api/sync の body に含めることで、サーバー
  // (UserSyncDO) が (calendar_id, device_id) 単位で syncToken を管理できるようにする —
  // 端末Aの同期が進めたトークンで端末Bが差分を取りこぼす設計欠陥の修正 (sync/syncRequest.ts 参照)。
  // 理論上 db より先に syncCalendarOnce が走ることは無いが、念のため null 許容にしてあり、
  // null のままなら (旧クライアントと同じ) レガシー共有トークン動作にフォールバックする
  const deviceIdRef = useRef<string | null>(null);

  const setDeviceId = useCallback((deviceId: string) => {
    deviceIdRef.current = deviceId;
  }, []);

  // 再認証待ち (reauthRequired) なアカウント id 集合 (2026-08-07)。accounts (/api/me の
  // AccountDTO.reauthRequired) から毎レンダー導出するだけの軽い派生値。
  // syncCalendarOnce/syncTaskList が「auto 経路かつこの集合に入っている」ときだけ実際の
  // fetch を止める (shouldSkipAutoSyncForReauth、sync/reauthSkip.ts 参照)
  const reauthRequiredAccountIds = useMemo(
    () => new Set(accounts.filter((a) => a.reauthRequired).map((a) => a.id)),
    [accounts],
  );

  const forgetAutoSyncedTaskLists = useCallback((accountId: string) => {
    for (const key of [...autoSyncedTaskListsRef.current]) {
      if (key.startsWith(`${accountId}:`)) autoSyncedTaskListsRef.current.delete(key);
    }
  }, []);

  // 1つの (accountId, calendarId) の同期の実処理。syncCalendar (下) から
  // syncSchedulerRef 経由でのみ呼ぶ(直接呼ばない — 多重実行ガードを迂回してしまうため)。
  // forceFull (2026-07-22、同期バックフィル用) は通常同期では false を渡す —
  // runSyncBackfillIfNeeded だけが true を渡す。trigger は省略不可 (このファイル冒頭の
  // コメント / sync/reauthSkip.ts 参照)
  const syncCalendarOnce = useCallback(
    async (
      accountId: string,
      calendarId: string,
      defaultColor: string | undefined,
      forceFull: boolean,
      trigger: SyncTrigger,
    ) => {
      if (!db) return;
      // 再認証待ちアカウントへの自動同期スキップ (2026-08-07)。本番実測: alarm を止めても
      // クライアントの自動同期が毎分 POST /api/sync を叩き続け invalid_grant を積み上げていた。
      // manual はここで弾かれない (常に false) ―― 握りつぶさずログだけ残す
      if (shouldSkipAutoSyncForReauth(trigger, reauthRequiredAccountIds.has(accountId))) {
        console.info(
          `kichijitsu: skip auto sync for reauth-pending account (${accountId}/${calendarId})`,
        );
        return;
      }
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
    [db, store, allDayStore, checkedFetch, reauthRequiredAccountIds],
  );

  // 1つの (accountId, calendarId) を同期する共通処理。runSync のループ、SSE hello/changed、
  // カレンダーを新規選択した直後の即時同期など複数経路から await なしで多重に発火しうるため、
  // syncSchedulerRef (キー = `${accountId}:${calendarId}`) で直列化する。同一カレンダーの
  // 増分同期と全同期(410 フォールバック)が交錯して IndexedDB の削除→再投入が競合するのを防ぐ
  // (2026-07-21、sync/syncScheduler.ts 参照)。
  //
  // forceFull の要求は coalesce: false で予約する (2026-07-31)。走行中の同期があると、通常同期は
  // 「最新に追いつければよい」ので他の要求に潰されて構わないが、forceFull はそうではない:
  //  - runFullResync (設定モーダルの「再同期」) は利用者が明示的に押した脱出口で、結果を報告する。
  //    走らなかったのに「再同期しました」と出るのが一番まずい。
  //  - runSyncBackfillIfNeeded は全成功したらバックフィル版数を記録してしまうので、走らずに
  //    成功扱いになると以後その世代が永久にバックフィルされない。
  // どちらも「実行されたこと自体」に意味があるため、スケジューラ側に「forceFull は強い」という
  // 知識を持たせるのではなく、呼び出し元のこの1行で「この要求は落とさないでほしい」と宣言する。
  // これで、通常同期 ⇄ forceFull がどちらの順で来ても forceFull が黙って消えない
  // (規則の詳細と、なぜ両方向に落ちないかは sync/syncScheduler.ts 冒頭のコメント参照)
  //
  // trigger は省略不可(このファイル冒頭のコメント / sync/reauthSkip.ts 参照)。
  // ここではスケジューラに載せて syncCalendarOnce へそのまま渡すだけで、判定自体は
  // syncCalendarOnce 側 (実際に fetch する直前) で行う
  const syncCalendar = useCallback(
    (
      accountId: string,
      calendarId: string,
      defaultColor: string | undefined,
      forceFull: boolean,
      trigger: SyncTrigger,
    ) =>
      syncSchedulerRef.current.schedule(
        calendarKey(accountId, calendarId),
        () => syncCalendarOnce(accountId, calendarId, defaultColor, forceFull, trigger),
        { coalesce: !forceFull },
      ),
    [syncCalendarOnce],
  );

  // 1つの (accountId, taskListId) を同期する共通処理(docs/google-tasks.md、syncCalendar のタスク版)。
  // Tasks API には syncToken が無く、応答は常にそのタスクリストの全件 (protocol.ts 参照)。
  // trigger は syncCalendarOnce と同じ役割(省略不可、再認証待ちアカウントの auto スキップ判定用)
  const syncTaskList = useCallback(
    async (accountId: string, taskListId: string, trigger: SyncTrigger) => {
      if (!db) return;
      if (shouldSkipAutoSyncForReauth(trigger, reauthRequiredAccountIds.has(accountId))) {
        console.info(
          `kichijitsu: skip auto sync for reauth-pending account (${accountId}/${taskListId})`,
        );
        return;
      }
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
    [db, taskStore, checkedFetch, reauthRequiredAccountIds],
  );

  // 選択中の全 (accountId, calendarId) ペア一覧(+ カレンダーのデフォルト色・primary か)。
  // 手動同期ボタン・自動同期・SSE hello 受信時の一巡 sync がいずれもこれを起点にする。
  // primary フラグは新規予定の書き込み先決定 (defaultWriteTarget、フェーズ5) にも使う
  const selectedTargets = useCallback((): WriteTargetCandidate[] => {
    const targets: WriteTargetCandidate[] = [];
    for (const account of accounts) {
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
  }, [accounts, calendarsByAccount, visibleCalendars]);

  // 取得済みの全 (accountId, taskListId) ペア一覧。v1 はタスクリストの表示 ON/OFF が無いため
  // (docs/google-tasks.md の TODO)、fetchTaskListsFor で取れたものは無条件に同期対象にする
  const selectedTaskListTargets = useCallback((): TaskListTarget[] => {
    const targets: TaskListTarget[] = [];
    for (const account of accounts) {
      for (const taskList of taskListsByAccount[account.id] ?? []) {
        targets.push({ accountId: account.id, taskListId: taskList.id });
      }
    }
    return targets;
  }, [accounts, taskListsByAccount]);

  // 新規予定 (フェーズ5) のデフォルトの書き込み先: 選択中カレンダーのうち primary が
  // あればそれ、無ければ先頭 (resolveDefaultWriteTarget、規則は eventCreate.ts 参照)。
  // null なら空き領域クリック/ドラッグでの新規作成自体を無効化する (WeekGrid/DayColumn 側)
  const writeTargetCandidates = useMemo(() => selectedTargets(), [selectedTargets]);
  const defaultWriteTarget = useMemo(
    () => resolveDefaultWriteTarget(writeTargetCandidates),
    [writeTargetCandidates],
  );

  // 「同期」ボタン・自動同期の共通処理: 選択中の全 (accountId, calendarId) ペア +
  // 取得済みの全 (accountId, taskListId) ペアを並行に同期する(docs/google-tasks.md でタスクも合流)。
  // trigger は呼び出し側が明示する ―― ツールバーの「同期」ボタンからは "manual"、
  // 起動時 useEffect (下) からは "auto" (再認証待ちアカウントのスキップ判定に使う、
  // sync/reauthSkip.ts 参照)。省略不可なのはこのファイル冒頭のコメントの通り
  const runSync = useCallback(
    async (trigger: SyncTrigger) => {
      if (!db) return;
      const targets = selectedTargets();
      const taskTargets = selectedTaskListTargets();
      if (targets.length === 0 && taskTargets.length === 0) return;

      setSyncStatus("syncing");
      const results = await Promise.allSettled([
        ...targets.map((t) => syncCalendar(t.accountId, t.calendarId, t.defaultColor, false, trigger)),
        ...taskTargets.map((t) => syncTaskList(t.accountId, t.taskListId, trigger)),
      ]);
      let hadError = false;
      for (const result of results) {
        if (result.status === "rejected") {
          hadError = true;
          console.error("kichijitsu: sync failed", result.reason);
        }
      }
      setSyncStatus(hadError ? "error" : "idle");
    },
    [db, selectedTargets, syncCalendar, selectedTaskListTargets, syncTaskList],
  );

  // 設定モーダルの「再同期」(2026-07-29、ユーザー要望)。runSync の全同期版で、
  // 対象の作り方も適用経路も runSync と同一 ―― 違いはカレンダーに forceFull: true を渡す点だけ。
  //
  // なぜ「サーバーの syncToken を捨てるエンドポイント」を新設しないのか: POST /api/sync の
  // forceFull (2026-07-22、同期バックフィル用) が既に「保存済み syncToken を読まずに全同期する」
  // そのものだから (apps/sync の core/sync-token-store.ts の wrapGetSyncTokenForForceFull)。
  // 全同期の応答は isFullSync: true で返り、applySyncResponse → applyFullSyncAtomic が
  // その (accountId, calendarId) のローカル複製を単一トランザクションで置き換えるので、
  // アプリ外で削除されたのに残ってしまった予定 (削除通知を取りこぼした残骸) もここで消える。
  //
  // 例外を握りつぶさず投げ直すのは runSync との意図的な差: 利用者が明示的に押した操作なので、
  // 「終わった/失敗した」を UI (SettingsModal の2段階確認) に伝えないと押し直す判断ができない。
  // その報告が嘘にならないことは syncCalendar が forceFull を coalesce: false で予約することで
  // 担保している(スケジューラが返す Promise は「その forceFull が実際に完走した」ことを表す)。
  //
  // trigger は常に "manual" 固定 (2026-08-07)。設定モーダルの「再同期」ボタンからしか
  // 呼ばれない = 利用者が明示的に押した経路そのものなので、外から渡させる必要はない
  // (再認証待ちアカウントでもここはスキップされない ―― sync/reauthSkip.ts 参照)
  const runFullResync = useCallback(async () => {
    if (!db) return;
    const targets = selectedTargets();
    const taskTargets = selectedTaskListTargets();
    if (targets.length === 0 && taskTargets.length === 0) return;

    setSyncStatus("syncing");
    // タスクは syncToken を持たず毎回そのタスクリストの全件で置き換わる (applyTasksSync.ts) ので、
    // forceFull 相当の区別は不要 ―― 通常の syncTaskList をそのまま混ぜれば全件取り直しになる
    const results = await Promise.allSettled([
      ...targets.map((t) => syncCalendar(t.accountId, t.calendarId, t.defaultColor, true, "manual")),
      ...taskTargets.map((t) => syncTaskList(t.accountId, t.taskListId, "manual")),
    ]);
    const failures = results.filter((result) => result.status === "rejected");
    for (const failure of failures) {
      console.error("kichijitsu: full resync failed", failure.reason);
    }
    setSyncStatus(failures.length > 0 ? "error" : "idle");
    if (failures.length > 0) {
      throw new Error(`full resync failed (${failures.length}/${results.length})`);
    }
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
  //
  // trigger は "auto" 固定 (2026-08-07)。起動シーケンスの一部として自動で走るだけで、
  // 利用者がこの瞬間の実行を意図してはいないため。
  //
  // 再認証待ちアカウントは対象から除外し(excludeReauthPendingTargets、無駄に
  // syncScheduler へ載せて即スキップさせるより先に弾く)、**除外が発生したらこの世代を
  // 記録しない** (2026-08-07、レビュー指摘)。理由は下の resolveEffectiveSyncBackfillVersion と
  // 同じ「永久に欠ける」事故 ―― 除外せずに版数を記録してしまうと、そのアカウントが後で
  // 再認証されてもこの世代のバックフィルを二度と受けられない
  // (sync/syncBackfill.ts の excludeReauthPendingTargets コメント参照)。
  const runSyncBackfillIfNeeded = useCallback(async () => {
    if (!db) return;
    const savedVersion = await getSyncBackfillVersion(db);
    // 記録してよいのは min(自世代, サーバー対応世代) まで (2026-07-25、sync/syncBackfill.ts の
    // resolveEffectiveSyncBackfillVersion 参照): web だけ先にデプロイされた状態で「サーバーがまだ
    // 返さないフィールド」をバックフィル済みと記録してしまうと、以後 forceFull が走らずその
    // フィールドが永久に欠ける。サーバーが追いついたら次回起動で残りの世代ぶんが自然に走る
    const targetVersion = resolveEffectiveSyncBackfillVersion(
      CURRENT_SYNC_BACKFILL_VERSION,
      serverSyncBackfillVersion,
    );
    const candidates = decideSyncBackfillTargets(savedVersion, targetVersion, selectedTargets());
    if (candidates.length === 0) return;

    const { targets, excludedReauthPending } = excludeReauthPendingTargets(
      candidates,
      reauthRequiredAccountIds,
    );
    if (excludedReauthPending) {
      // 握りつぶさず、記録を見送ったことを開発者が追える形で残す(利用者への表示は不要 ――
      // ツールバーの再認証警告が既に出ている)
      console.info(
        "kichijitsu: sync backfill excluded reauth-pending account(s); withholding version record, will retry next launch",
      );
    }
    if (targets.length === 0) return;

    const results = await Promise.allSettled(
      targets.map((t) => syncCalendar(t.accountId, t.calendarId, t.defaultColor, true, "auto")),
    );
    const allOk = results.every((r) => r.status === "fulfilled") && !excludedReauthPending;
    if (allOk) {
      await setSyncBackfillVersion(db, targetVersion);
    } else {
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("kichijitsu: sync backfill failed, will retry next launch", result.reason);
        }
      }
    }
  }, [db, selectedTargets, syncCalendar, serverSyncBackfillVersion, reauthRequiredAccountIds]);

  // SSE hello 受信時(接続・再接続時): 取りこぼしがあり得るため選択中カレンダーを一巡 sync する。
  // runSync と違い、同時多発を避けて直列(1件ずつ await)で回す。
  // 利用者が意図していない経路なので trigger は "auto" 固定 (2026-08-07、sync/reauthSkip.ts 参照)
  const handleServerHello = useCallback(async () => {
    if (!db) return;
    const targets = selectedTargets();
    if (targets.length === 0) return;

    setSyncStatus("syncing");
    let hadError = false;
    for (const t of targets) {
      try {
        await syncCalendar(t.accountId, t.calendarId, t.defaultColor, false, "auto");
      } catch (err) {
        hadError = true;
        console.error("kichijitsu: SSE hello sync failed", err);
      }
    }
    setSyncStatus(hadError ? "error" : "idle");
  }, [db, selectedTargets, syncCalendar]);

  // SSE changed 受信時: 該当 (accountId, calendarId) が選択中の場合のみ sync する
  // (通知のペイロード自体は信用せず、選択状態は常にクライアント側の visibleCalendars で判定する)。
  // handleServerHello と同じ理由で trigger は "auto" 固定
  const handleServerChanged = useCallback(
    (accountId: string, calendarId: string) => {
      if (!db) return;
      if (!(visibleCalendars[accountId] ?? []).includes(calendarId)) return;
      const defaultColor = calendarsByAccount[accountId]?.find(
        (c) => c.id === calendarId,
      )?.backgroundColor;

      setSyncStatus("syncing");
      syncCalendar(accountId, calendarId, defaultColor, false, "auto")
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
    enabled: accounts.length > 0,
    onHello: handleServerHello,
    onChanged: handleServerChanged,
    onOpen: markOnline,
    onError: markOffline,
  });

  // 接続済み & DB 準備完了 & 選択中カレンダーが読み込まれたら起動時に1回だけ自動同期する。
  // 完了後に続けて runSyncBackfillIfNeeded を1回だけ走らせる(2026-07-22) — 通常同期
  // (runSync 自体)とバックフィルの forceFull 同期が同時に飛んで syncScheduler 上で
  // 競合しないよう、意図的に「まず通常同期が完了してから」の直列にしてある。
  // trigger は "auto" 固定 (2026-08-07) ―― ページ起動そのものであり利用者の操作ではないため
  // (再認証待ちアカウントはここでスキップされる、sync/reauthSkip.ts 参照)
  useEffect(() => {
    if (!db || accounts.length === 0 || Object.keys(visibleCalendars).length === 0) return;
    if (autoSyncedRef.current) return;
    autoSyncedRef.current = true;
    runSync("auto").then(() => runSyncBackfillIfNeeded());
  }, [db, accounts, visibleCalendars, runSync, runSyncBackfillIfNeeded]);

  // タスクリストが新たに見つかるたびに、その (accountId, taskListId) を1回だけ自動同期する
  // (docs/google-tasks.md)。fetchTaskListsFor の完了タイミングは calendarsByAccount/visibleCalendars の
  // 準備完了と揃わないことがあるため、上の「起動時1回だけ」の autoSyncedRef とは別に、
  // タスクリスト単位で「初めて見つかった」ことを autoSyncedTaskListsRef で判定する。
  // Tasks API には push 通知が無い (docs/google-tasks.md) ため、以降の更新反映は「同期」ボタン
  // (runSync) 頼みになる — TODO: 定期ポーリングでの自動更新
  // trigger は "auto" 固定 (2026-08-07) ―― タスクリストが見つかったことを検知して自動で
  // 走るだけで、利用者の操作ではないため
  useEffect(() => {
    if (!db) return;
    const targets = selectedTaskListTargets();
    const toSync = targets.filter(
      (t) =>
        !autoSyncedTaskListsRef.current.has(taskListKey(t.accountId, t.taskListId)) &&
        // 再認証待ちのアカウントは対象にすらしない。syncTaskList の中でスキップさせると、
        // 下の autoSyncedTaskListsRef への記録だけが済んでしまい「同期済み」扱いになる。
        // この effect は「初めて見つかったとき1回だけ」で、以降の更新反映は同期ボタン頼み
        // (上のコメント参照) なので、再認証を済ませてもリロードするまでタスクが出てこない。
        // バックフィルの世代記録 (runSyncBackfillIfNeeded) と同じ「スキップを成功として
        // 記録しない」原則。
        !reauthRequiredAccountIds.has(t.accountId),
    );
    if (toSync.length === 0) return;
    for (const t of toSync)
      autoSyncedTaskListsRef.current.add(taskListKey(t.accountId, t.taskListId));
    Promise.allSettled(toSync.map((t) => syncTaskList(t.accountId, t.taskListId, "auto"))).then(
      (results) => {
        for (const result of results) {
          if (result.status === "rejected") {
            console.error("kichijitsu: initial task list sync failed", result.reason);
          }
        }
      },
    );
    // reauthRequiredAccountIds を依存に入れるのは、再認証が済んで集合から外れたときに
    // この effect をもう一度走らせ、上でスキップしたタスクリストを拾い直すため。
  }, [
    db,
    taskListsByAccount,
    selectedTaskListTargets,
    syncTaskList,
    reauthRequiredAccountIds,
  ]);

  return {
    syncStatus,
    defaultWriteTarget,
    writeTargetCandidates,
    runSync,
    runFullResync,
    syncCalendar,
    setDeviceId,
    forgetAutoSyncedTaskLists,
  };
}
