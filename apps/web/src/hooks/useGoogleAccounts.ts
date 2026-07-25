import { useCallback, useEffect, useRef, useState } from "react";
import type { IDBPDatabase } from "idb";
import type {
  AccountDTO,
  CalendarListEntryDTO,
  DisconnectRequest,
  MeResponse,
  TaskListDTO,
  TaskListsResponse,
  WatchRequest,
} from "@kichijitsu/shared";
import {
  setDeclinedVisibilitySettings,
  setHiddenTaskLists,
  setVisibleCalendars,
  type KichijitsuDB,
  type VisibleCalendarsMap,
} from "../db/database";
import { taskListKey } from "../layout/keys";
import { addToSet, removeFromSet } from "../layout/setOps";
import type { AllDayStore } from "../store/allDayStore";
import type { OccurrenceStore } from "../store/occurrenceStore";
import type { TaskStore } from "../store/taskStore";
import { deleteGoogleData } from "../sync/applySync";
import { deleteTasksForAccount } from "../sync/applyTasksSync";
import {
  DEFAULT_DECLINED_VISIBILITY,
  type DeclinedVisibilitySettings,
} from "../sync/declinedVisibility";
import { deleteJson, getJson, jsonInit, type CheckedFetch } from "../sync/httpJson";
import {
  buildVisibleCalendarsRequest,
  mergeServerVisibleCalendarsWithPending,
  nextPendingVisiblePuts,
  nextVisibleCalendarsForAccount,
} from "../sync/visibleCalendars";

/**
 * Google 連携アカウントと「何を表示するか」の状態をまとめたフック
 * (リファクタリング フェーズ2 ⑥、2026-07-25 に App.tsx から移設)。持っているのは:
 *
 *  - **連携状態** (`me` = GET /api/me の応答。accounts / visibleCalendars / github)。
 *    起動時と `online` イベントで取り直す (checkMe)。
 *  - **カレンダー一覧** (`calendarsByAccount` = GET /api/calendars) と
 *    **タスクリスト一覧** (`taskListsByAccount` = GET /api/tasklists、403 は
 *    tasks スコープ未付与として `tasksScopeMissingAccounts` に記録)。
 *  - **表示設定**: カレンダー選択 (`visibleCalendars`、サーバー同期あり)、タスクリストの
 *    非表示集合 (`hiddenTaskLists`、この端末のみ)、不参加表示 (`declinedVisibility`、同じ)。
 *    いずれも IndexedDB meta へ永続化する(読み込みは db/bootstrap.ts が行い、
 *    このフックの loadStored* を呼んで state に流し込む)。
 *  - **アカウント連携解除** (disconnectAccount): サーバー DELETE + 上記 state + ローカル
 *    データ(occurrences / 終日 / タスク)の掃除。
 *
 * **ここに同期 (POST /api/sync) は入っていない**。カレンダーのトグルは
 * 「選択したら即そのカレンダーだけ同期する」ため hooks/useCalendarSync.ts と循環しかけるが、
 * 同期側 (useCalendarSync) がこのフックの state (accounts/calendarsByAccount/visibleCalendars)
 * を一方向に受け取る形にし、**両者を繋ぐグルーは App.tsx に残してある**
 * (handleToggleCalendar が toggleCalendarVisibility → syncCalendar を順に呼ぶ)。
 * フックを相互参照させるより、循環は配線層に置くほうが読めるという判断。
 *
 * 呼び出し位置の制約(App.tsx 側): `me` を useBlockRules / useGitHubData が引数に取るため、
 * このフックはそれらより**前**で呼ばなければならない(フックの引数はレンダー中に評価される)。
 * その結果、移設前は useGitHubData の後に登録されていた永続化 effect (visibleCalendars /
 * hiddenTaskLists / declinedVisibility) と一覧取得 effect (accounts 増加時・設定パネル
 * オープン時) が、useBlockRules/useGitHubData の effect より先に登録される。これらは
 * 初回マウント時にはすべてガードで空振りし(loaded ref が false、accounts が空、
 * panelOpen が false)、以後も GitHub 系の effect とは読み書きする state が完全に分かれている
 * ため、登録順の入れ替えで挙動は変わらない。
 */
export interface GoogleAccountsController {
  /** GET /api/me の応答。未接続時は connected:false / accounts:[] の既定値 */
  me: MeResponse;
  /** accountId → そのアカウントのカレンダー一覧 */
  calendarsByAccount: Record<string, CalendarListEntryDTO[]>;
  /** accountId → 選択中カレンダー id 一覧(サーバーと IndexedDB の両方に保存する) */
  visibleCalendars: VisibleCalendarsMap;
  /** accountId → そのアカウントのタスクリスト一覧(403 のアカウントはキーが付かない) */
  taskListsByAccount: Record<string, TaskListDTO[]>;
  /** tasks スコープ未付与 (GET /api/tasklists が 403) のアカウント id 集合 */
  tasksScopeMissingAccounts: ReadonlySet<string>;
  /** 明示的に非表示にした `${accountId}:${taskListId}` の集合(既定は全 ON) */
  hiddenTaskLists: ReadonlySet<string>;
  /** 「不参加を表示」設定(この端末のみのローカル設定) */
  declinedVisibility: DeclinedVisibilitySettings;
  /**
   * IndexedDB から読んだ選択中カレンダーを流し込む (db/bootstrap.ts から呼ぶ)。
   * **prev 優先マージ**なので、/api/calendars 側の primary デフォルト選択が先に
   * 書き込まれていても握り潰さない(下の実装のコメント参照)。
   */
  loadStoredVisibleCalendars: (stored: VisibleCalendarsMap) => void;
  /** IndexedDB から読んだタスクリスト非表示集合を流し込む (db/bootstrap.ts から呼ぶ) */
  loadStoredHiddenTaskLists: (stored: ReadonlySet<string>) => void;
  /** IndexedDB から読んだ不参加表示設定を流し込む (db/bootstrap.ts から呼ぶ) */
  loadStoredDeclinedVisibility: (stored: DeclinedVisibilitySettings) => void;
  /**
   * 左ペインのカレンダー表示チェック。state の楽観更新 + POST /api/watch +
   * PUT /api/visible-calendars までを行う。**選択時の即時同期は含まない** ――
   * それは App.tsx のグルー (handleToggleCalendar) が useCalendarSync と繋ぐ。
   */
  toggleCalendarVisibility: (accountId: string, calendarId: string, nextChecked: boolean) => void;
  /** 左ペインのタスクリスト表示チェック(サーバー同期なし、非表示集合の更新だけ) */
  toggleTaskList: (accountId: string, taskListId: string, nextChecked: boolean) => void;
  /** 左ペイン「表示」セクションの「不参加を表示」チェック */
  toggleShowDeclined: () => void;
  /** 同セクションのサブオプション「自分が主催の予定は残す」チェック */
  toggleKeepOrganizerDeclined: () => void;
  /**
   * アカウント単位の連携解除。失敗は呼び出し元(パネルの行 UI)に伝播させる。
   *
   * @param onForgetAccount 同期側 (useCalendarSync) が持つ「そのアカウントの既知集合」の
   *   掃除。移設前はこの掃除が state の畳み込みとローカルデータ削除の**間**にあったため、
   *   その位置で呼べるようフックを跨いだ関数を引数で受け取る形にしてある
   *   (循環を配線層に置くための引数 ―― App.tsx のグルーが渡す)。
   */
  disconnectAccount: (
    accountId: string,
    onForgetAccount?: (accountId: string) => void,
  ) => Promise<void>;
  /** GitHub 連携解除の成功後に me.github を null に戻す(App.tsx のグルーから呼ぶ) */
  clearGitHubConnection: () => void;
}

/**
 * @param db 起動シーケンス完了までは null(永続化 effect と連携解除のローカル掃除は待つ)
 * @param panelOpen 設定モーダルの開閉。開いた瞬間だけ未取得アカウントの再フェッチを試みる
 */
export function useGoogleAccounts({
  db,
  store,
  allDayStore,
  taskStore,
  panelOpen,
  checkedFetch,
}: {
  db: IDBPDatabase<KichijitsuDB> | null;
  store: OccurrenceStore;
  allDayStore: AllDayStore;
  taskStore: TaskStore;
  panelOpen: boolean;
  checkedFetch: CheckedFetch;
}): GoogleAccountsController {
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
  // 上の hiddenTaskLists 永続化 effect が、起動シーケンス (db/bootstrap.ts) の IndexedDB
  // 読み込み完了前に空集合で上書きしてしまわないためのガード(visibleCalendarsLoadedRef と同じ役割)
  const hiddenTaskListsLoadedRef = useRef(false);
  // 「不参加を表示」設定(参加ステータス表示、2026-07-22)。左ペイン(CalendarPane)の
  // 「表示」セクションで ON/OFF する。hiddenTaskLists と同じ流儀 ―― この端末のみの
  // ローカル設定で、サーバー同期はしない(db/database.ts の getDeclinedVisibilitySettings 参照)
  const [declinedVisibility, setDeclinedVisibilityState] = useState<DeclinedVisibilitySettings>(
    DEFAULT_DECLINED_VISIBILITY,
  );
  // 上の declinedVisibility 永続化 effect が、IndexedDB 読み込み完了前に
  // 既定値で上書きしてしまわないためのガード(hiddenTaskListsLoadedRef と同じ役割)
  const declinedVisibilityLoadedRef = useRef(false);
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
  // getVisibleCalendars(db) での初回ロード(db/bootstrap.ts)が終わるまでは、下の永続化 effect を
  // 発火させない({} で上書きしてしまわないためのガード)
  const visibleCalendarsLoadedRef = useRef(false);
  // PUT /api/visible-calendars の lost update 防止 (2026-07-21)。オフライン中/失敗時に
  // その accountId の最新 calendarIds を記録しておき、checkMe (起動時・online 復帰時) の
  // 先頭で再送してから /api/me をマージする(sync/visibleCalendars.ts 参照)
  const pendingVisiblePutsRef = useRef<Map<string, string[]>>(new Map());
  // fetchCalendarsFor がデフォルト選択(primary)を初適用したかどうかを同期的に判定するための
  // 直近の visibleCalendars スナップショット(POST /api/watch の登録要否判定に使う。
  // レンダーごとに更新するだけで、これ自体は再レンダーを起こさない)
  const visibleCalendarsRef = useRef<VisibleCalendarsMap>({});
  visibleCalendarsRef.current = visibleCalendars;

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

  // toggleCalendarVisibility のトグル時と、fetchCalendarsFor の初回 primary デフォルト選択時に
  // 呼ぶ fire-and-forget 版: UI/IndexedDB は既に楽観的更新済みなので、失敗してもロールバックしない
  // (選択はローカルに残るため動作は継続でき、オフライン表示は checkedFetch の markOffline に委ねる。
  // 失敗の追跡は putVisibleCalendarsOnce 内の pendingVisiblePutsRef が担う)
  const putVisibleCalendars = useCallback(
    (accountId: string, calendarIds: string[]) => {
      void putVisibleCalendarsOnce(accountId, calendarIds);
    },
    [putVisibleCalendarsOnce],
  );

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
      // 参照。起動シーケンスの IndexedDB ロードとの解決順序に依存しない — どちらが先でも
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

  // visibleCalendars が変わるたびに IndexedDB meta へ永続化する。
  // 初回ロード(db/bootstrap.ts → loadStoredVisibleCalendars)が完了するまでは待つ
  // ({} での上書きを防ぐ)
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

  const loadStoredVisibleCalendars = useCallback((stored: VisibleCalendarsMap) => {
    // ここで単純に setVisibleCalendarsState(stored) すると、上の
    // 「me.accounts が増えるたびにカレンダー一覧を取得する」effect が
    // (/api/me・/api/calendars は同一プロセス内の高速な往復のため) この
    // DB 読み込みより先に primary デフォルト選択を書き込んでいた場合、
    // それを空の stored で握り潰してしまう(= 一生 primary が
    // 選ばれないまま {} が永続化される既知のバグだった)。
    // 既に state にある値(prev)を優先してマージすることで、どちらが
    // 先に解決してもデフォルト選択が失われないようにする
    setVisibleCalendarsState((prev) => ({ ...stored, ...prev }));
    visibleCalendarsLoadedRef.current = true;
  }, []);

  // タスクリスト表示 ON/OFF(左ペイン増分2): サーバー同期が無くこの端末の IndexedDB が
  // 唯一の正なので、visibleCalendars のような server/prev マージは不要 ―― 素直に読み込むだけ
  const loadStoredHiddenTaskLists = useCallback((stored: ReadonlySet<string>) => {
    setHiddenTaskListsState(stored);
    hiddenTaskListsLoadedRef.current = true;
  }, []);

  // 「不参加を表示」設定(参加ステータス表示): hiddenTaskLists と同じくこの端末の
  // IndexedDB が唯一の正なので、素直に読み込むだけでよい
  const loadStoredDeclinedVisibility = useCallback((stored: DeclinedVisibilitySettings) => {
    setDeclinedVisibilityState(stored);
    declinedVisibilityLoadedRef.current = true;
  }, []);

  // 左ペイン(CalendarPane、カレンダーナビゲーション増分1)でのカレンダー表示チェック操作
  // (旧: カレンダー設定パネル内のチェック、増分1で CalendarPane へ移設。ロジックは無変更)。
  // 選択解除時にローカルデータを削除しないのは意図的(App.tsx のグルー側コメント参照)。
  const toggleCalendarVisibility = useCallback(
    (accountId: string, calendarId: string, nextChecked: boolean) => {
      const current = visibleCalendars[accountId] ?? [];
      const nextForAccount = nextVisibleCalendarsForAccount(current, calendarId, nextChecked);
      setVisibleCalendarsState((prev) => ({ ...prev, [accountId]: nextForAccount }));
      postWatch(accountId, calendarId, nextChecked);
      // サーバーへ保存(端末間同期、2026-07-20)。UI/IndexedDB は上ですでに楽観的更新済み
      putVisibleCalendars(accountId, nextForAccount);
    },
    [visibleCalendars, postWatch, putVisibleCalendars],
  );

  // 左ペイン(CalendarPane、増分2)でのタスクリスト表示チェック操作。カレンダー選択
  // (toggleCalendarVisibility)と違いサーバー同期は行わず、ローカルの hiddenTaskLists
  // (「明示的に OFF にした集合」)を更新するだけ ―― タスクの同期(syncTaskList)自体は
  // 表示 ON/OFF に関係なく続行する(selectedTaskListTargets 参照、再 ON 時の即時性を優先)
  const toggleTaskList = useCallback(
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
  const toggleShowDeclined = useCallback(() => {
    setDeclinedVisibilityState((prev) => ({ ...prev, showDeclined: !prev.showDeclined }));
  }, []);

  // サブオプション「自分が主催の予定は残す」。showDeclined が true のときは意味を持たない
  // (shouldHideDeclined 参照)が、状態自体は独立して保持する(再度 showDeclined を OFF にした
  // ときに前回の選択を覚えていてほしいため)。
  const toggleKeepOrganizerDeclined = useCallback(() => {
    setDeclinedVisibilityState((prev) => ({
      ...prev,
      keepOrganizerDeclined: !prev.keepOrganizerDeclined,
    }));
  }, []);

  // アカウント単位の連携解除。サーバー側 (Google revoke + データ削除 + cookie 更新) を
  // DELETE /api/account に任せ、成功したらそのアカウントに関する状態(accounts・カレンダー一覧・
  // 選択状態・ローカルの google データ)を全て畳む。失敗時は呼び出し元(パネルの行UI)が
  // catch して表示するので、ここでは reject をそのまま伝播する
  const disconnectAccount = useCallback(
    async (accountId: string, onForgetAccount?: (accountId: string) => void) => {
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
      // 同期側 (useCalendarSync) が持つ「自動同期済みのタスクリスト」の既知集合の掃除。
      // 移設前はこの位置に autoSyncedTaskListsRef の削除ループが直接あったため、
      // 順序を変えないようここで呼ぶ(引数で受け取る理由は型定義のコメント参照)
      onForgetAccount?.(accountId);

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

  // GitHub 連携解除 (docs/github-integration.md フェーズ①Part B) の成功後に呼ばれる。
  // GitHub 由来のローカルデータの掃除は hooks/useGitHubData.ts の責務なので、ここは
  // me.github を null に戻すだけ(App.tsx のグルー handleDisconnectGitHub が両方を呼ぶ)
  const clearGitHubConnection = useCallback(() => {
    setMe((prev) => ({ ...prev, github: null }));
  }, []);

  return {
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
    toggleTaskList,
    toggleShowDeclined,
    toggleKeepOrganizerDeclined,
    disconnectAccount,
    clearGitHubConnection,
  };
}
