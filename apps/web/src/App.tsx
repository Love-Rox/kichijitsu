import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Temporal } from '@js-temporal/polyfill'
import type { IDBPDatabase } from 'idb'
import type {
  AccountDTO,
  CalendarListEntryDTO,
  DisconnectRequest,
  EventCreateResponse,
  MeResponse,
  SyncRequest,
  SyncResponse,
  WatchRequest,
} from '@kichijitsu/shared'
import { buildEventDeleteRequest, buildEventPatchRequest } from './sync/eventPatch'
import {
  buildEventCreateRequest,
  buildPendingOccurrence,
  finalizeCreatedOccurrence,
  resolveDefaultWriteTarget,
  type WriteTargetCandidate,
} from './sync/eventCreate'
import { WeekGrid } from './components/WeekGrid'
import { MonthView } from './components/MonthView'
import { LogoMark, LogoWordmark } from './components/Logo'
import { MasuIndicator } from './components/MasuIndicator'
import { CalendarSettingsPanel } from './components/CalendarSettingsPanel'
import { KeyboardHelpOverlay } from './components/KeyboardHelpOverlay'
import { SearchOverlay } from './components/SearchOverlay'
import type { CalendarInfo } from './components/EventBlock'
import { isEditableTarget, isViewAllowedForWidth, resolveShortcut, type View } from './keyboard/shortcuts'
import { useMasuVisible } from './hooks/useMasuVisible'
import { useMediaQuery } from './hooks/useMediaQuery'
import { useOffline } from './hooks/useOffline'
import { useServerEvents } from './hooks/useServerEvents'
import { generateDummyOccurrences, generateDummyOverrides, generateDummySeries } from './model/dummy'
import { instanceId } from './model/series'
import type { Occurrence } from './model/types'
import { OccurrenceStore } from './store/occurrenceStore'
import { AllDayStore } from './store/allDayStore'
import {
  cleanupDemoData,
  cleanupLegacyGoogleData,
  countSeries,
  deleteOccurrencesByIds,
  deleteOverridesByIds,
  getAllAllDayOccurrences,
  getExpansionState,
  getOccurrencesBetween,
  getOverride,
  getVisibleCalendars,
  openKichijitsuDB,
  putOccurrence,
  putOccurrences,
  putOverride,
  putSeries,
  setVisibleCalendars,
  type KichijitsuDB,
  type VisibleCalendarsMap,
} from './db/database'
import { ensureExpanded } from './expansion/ensureExpanded'
import { resolveJumpDate, type SearchJumpTarget } from './search/searchOccurrences'
import { applySyncResponse, deleteGoogleData } from './sync/applySync'
import { mondayOf, monthGridRangeMs } from './layout/monthGrid'
import { stepAnchor } from './layout/dayGrid'
import './App.css'

/**
 * モバイル対応フェーズ2(docs/multiplatform.md): 週ビュー('week')に加えて、狭幅向けの
 * N日タイムライン(day3=3日、day1=1日)を追加する。'month' は従来通り別レイアウト。
 * WeekGrid はこのうち 'month' 以外を dayCount 可変の同一グリッドとして描画する。
 * View 型そのものは keyboard/shortcuts.ts を正としてそこから import する
 * (グローバルショートカットの view 切替キーが同じ許容規則を参照する必要があるため)。
 */

/** view ごとの表示日数。'month' は WeekGrid を使わないため呼ばない想定(0を返す) */
function dayCountForView(view: View): number {
  switch (view) {
    case 'week':
      return 7
    case 'day3':
      return 3
    case 'day1':
      return 1
    case 'month':
      return 0
  }
}

const VIEW_STORAGE_KEY = 'kichijitsu:view'

function isView(value: string): value is View {
  return value === 'week' || value === 'month' || value === 'day3' || value === 'day1'
}

/** localStorage に保存された前回選択 view を読む。プライベートモード等で無効なら null */
function loadStoredView(): View | null {
  try {
    const v = window.localStorage.getItem(VIEW_STORAGE_KEY)
    return v && isView(v) ? v : null
  } catch {
    return null
  }
}

/** 初回マウント時の view の決め方(localStorage 優先、無ければ画面幅から)。App() の useState 初期化子から呼ぶ */
function initialView(isNarrow: boolean): View {
  const stored = loadStoredView()
  if (stored && isViewAllowedForWidth(stored, isNarrow)) return stored
  // 初回訪問(保存済み view 無し): 狭幅では Notion Calendar に倣い3日タイムラインを既定にする
  return isNarrow ? 'day3' : 'week'
}

/**
 * 初回マウント時の timelineStart の決め方。week は従来通り「今週の月曜」から始めるが、
 * day3/day1 は「今日」を先頭日にする(月曜始まりにすると、週の後半に開いたときに
 * 過去の日しか見えない/今日が画面外になりうるため、3日/1日タイムラインでは意味がない)。
 */
function initialTimelineStart(view: View): Temporal.PlainDate {
  const today = Temporal.Now.plainDateISO()
  return view === 'week' ? mondayOf(today) : today
}

/**
 * デモ/シードデータの自動投入を許可するかどうか (2026-07-20、実データ運用への移行)。
 * 通常起動では常に false — 実データ (Google 連携) だけを表示する。
 * ローカル開発で UI を素早く確認したいときだけ、`import.meta.env.DEV` (本番ビルドでは
 * 常に false に固定される) かつ URL に `?demo=1` を付けた場合のみダミーの週間データを
 * シードする退避経路として残してある。
 */
const DEMO_SEED_ENABLED =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get('demo') === '1'

/**
 * [start, start+dayCount日) の epoch ms 範囲(timeZone の壁時計基準)。
 * week/day3/day1 のどのタイムラインビューでも共通で使う(モバイル対応フェーズ2で
 * dayCount=7 固定の weekRangeMs から一般化)。
 */
function timelineRangeMs(
  start: Temporal.PlainDate,
  dayCount: number,
  timeZone: string,
): { fromMs: number; toMs: number } {
  const fromMs = start.toZonedDateTime({ timeZone }).epochMilliseconds
  const toMs = start.add({ days: dayCount }).toZonedDateTime({ timeZone }).epochMilliseconds
  return { fromMs, toMs }
}

// 週切替アニメーション(WeekGrid 側 SLIDE_MS=200ms)より少し長めに連打をロックする
const NAV_LOCK_MS = 220

function App() {
  const timeZone = useMemo(() => Temporal.Now.timeZoneId(), [])
  // モバイル対応フェーズ2: 狭幅(~640px 未満)かどうか。既定 view の選択(下)と
  // ツールバーのビュー切替ボタン構成(1日/3日/月 ⇔ 週/月)の両方に使う
  const isNarrow = useMediaQuery('(max-width: 640px)')
  // 月表示ビュー(フェーズ6)。timelineStart とは独立した状態にし、view 切替時に
  // 双方をその場で同期させる(switchView 参照)。常に「月内の1日」を指す
  const [view, setView] = useState<View>(() => initialView(isNarrow))
  // タイムラインビュー(week/day3/day1)共通の表示開始日。dayCount(view に応じて7/3/1)ぶんの
  // N日タイムラインとして WeekGrid に渡す(モバイル対応フェーズ2、docs/multiplatform.md)。
  // 初期値は view に応じる(initialTimelineStart 参照: week=今週の月曜、day3/day1=今日)
  const [timelineStart, setTimelineStart] = useState<Temporal.PlainDate>(() => initialTimelineStart(view))
  const [monthCursor, setMonthCursor] = useState(() => Temporal.Now.plainDateISO().with({ day: 1 }))
  const dayCount = dayCountForView(view)
  const navLockRef = useRef(false)

  // ユーザーが明示的に選んだ view を覚えておき、次回訪問時のデフォルトにする(任意機能)。
  // localStorage が使えない環境(プライベートモード等)では静かに無視する
  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, view)
    } catch {
      /* ignore */
    }
  }, [view])

  const store = useMemo(() => new OccurrenceStore(), [])
  const allDayStore = useMemo(() => new AllDayStore(), [])
  const [db, setDb] = useState<IDBPDatabase<KichijitsuDB> | null>(null)

  // マルチアカウント対応 (2026-07-19): me.accounts[] を回って各アカウントの
  // カレンダー一覧を取得し、選択中カレンダー(IndexedDB meta に永続化)ごとに同期する。
  const [me, setMe] = useState<MeResponse>({ connected: false, accounts: [] })
  const [calendarsByAccount, setCalendarsByAccount] = useState<Record<string, CalendarListEntryDTO[]>>({})
  const [visibleCalendars, setVisibleCalendarsState] = useState<VisibleCalendarsMap>({})
  const [panelOpen, setPanelOpen] = useState(false)
  // '?' キーでトグルするキーボードショートカット ヘルプオーバーレイ(フェーズ6)
  const [helpOpen, setHelpOpen] = useState(false)
  // 予定検索オーバーレイ(フェーズ6)の開閉。ツールバーの検索ボタンからのみ開く
  // (キーボードショートカット化は別途 keyboard/shortcuts.ts 側の対応が必要なため今回は配線しない)
  const [searchOpen, setSearchOpen] = useState(false)
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'error'>('idle')
  // Google への書き戻し (POST /api/event/patch) 失敗時のロールバック通知
  // (フェーズ5)。syncStatus とは別軸: こちらはドラッグ確定1件ごとの結果
  const [saveError, setSaveError] = useState(false)
  const saveErrorTimeoutRef = useRef<number | undefined>(undefined)
  const autoSyncedRef = useRef(false)
  // 「このアカウントのカレンダー一覧は初回フェッチ済み/フェッチ中」フラグ。
  // me.accounts effect が同じアカウントに何度も初回フェッチを走らせないためのもの。
  // 取得失敗したアカウントの再フェッチ(リトライ)はこれとは別に calendarsByAccount の
  // 有無で判定する(下の panelOpen effect 参照)
  const fetchedAccountsRef = useRef(new Set<string>())
  // 同一アカウントへの並行フェッチ防止(初回フェッチとパネルオープン時のリトライが
  // 同時に走るケースがあるため)
  const fetchInFlightRef = useRef(new Set<string>())
  // getVisibleCalendars(db) での初回ロードが終わるまでは、下の永続化 effect を
  // 発火させない({} で上書きしてしまわないためのガード)
  const visibleCalendarsLoadedRef = useRef(false)
  const accountAreaRef = useRef<HTMLDivElement>(null)
  // fetchCalendarsFor がデフォルト選択(primary)を初適用したかどうかを同期的に判定するための
  // 直近の visibleCalendars スナップショット(POST /api/watch の登録要否判定に使う。
  // レンダーごとに更新するだけで、これ自体は再レンダーを起こさない)
  const visibleCalendarsRef = useRef<VisibleCalendarsMap>({})
  visibleCalendarsRef.current = visibleCalendars

  // オフライン表示(brand/README.md「枡オーナメント」節: 空枡+「オフライン」)。
  // fetch 経路は checkedFetch を薄く差し込んで判定する(useOffline.ts 参照)
  const { offline, markOffline, markOnline } = useOffline()
  const checkedFetch = useCallback(
    async (input: string, init?: RequestInit): Promise<Response> => {
      let res: Response
      try {
        res = await fetch(input, init)
      } catch (err) {
        markOffline()
        throw err
      }
      // vite の dev proxy はバックエンド不在時に 502 を返す(App.tsx の他の箇所と同じ想定)。
      // それ以外の応答は「サーバーに届いている」ことの証跡として online 扱いにする
      if (res.status === 502) {
        markOffline()
      } else {
        markOnline()
      }
      return res
    },
    [markOffline, markOnline],
  )

  // POST /api/watch — 選択中カレンダーの push 通知登録/解除。fire-and-forget
  // (登録は best-effort。失敗してもアラームポーリングが補うので UI はブロックしない)
  const postWatch = useCallback(
    (accountId: string, calendarId: string, enabled: boolean) => {
      checkedFetch('/api/watch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, calendarId, enabled } satisfies WatchRequest),
      })
        .then((res) => {
          if (!res.ok) {
            console.warn(`kichijitsu: POST /api/watch failed (${accountId}/${calendarId}): ${res.status}`)
          }
        })
        .catch((err) => {
          console.warn('kichijitsu: POST /api/watch failed', err)
        })
    },
    [checkedFetch],
  )

  // 初回ロード中(db==null, store に最初のデータがまだ入っていない)かどうか。
  // グリッド中央に枡インジケーターをオーバーレイし、初期化完了で消す
  const initializing = db === null
  const initIndicator = useMasuVisible(initializing)
  const syncIndicator = useMasuVisible(syncStatus === 'syncing')

  // 起動時: DB を開く → 初回のみ dummy データをシード → 表示週ぶんを展開 →
  // 展開済み範囲全体(単発イベント込み)を store に反映する → 選択中カレンダーを読み込む
  useEffect(() => {
    let cancelled = false

    async function init() {
      const database = await openKichijitsuDB()
      if (cancelled) return

      // レガシー掃除(一回きり・冪等): ID スコープ化 (2026-07-19) 以前の旧形式
      // Google データ (`g:<eventId>`、accountId/calendarId フィールドなし) は
      // 現行のフィルタにマッチしない不可視の残骸なので削除する。0件なら何も出さない
      const legacyCleanup = await cleanupLegacyGoogleData(database)
      if (cancelled) return
      const legacyTotal =
        legacyCleanup.seriesRemoved + legacyCleanup.occurrencesRemoved + legacyCleanup.overridesRemoved
      if (legacyTotal > 0) {
        console.info(
          `kichijitsu: legacy Google data cleanup removed ${legacyTotal} record(s) ` +
            `(series=${legacyCleanup.seriesRemoved}, occurrences=${legacyCleanup.occurrencesRemoved}, ` +
            `overrides=${legacyCleanup.overridesRemoved})`,
        )
      }

      // デモ/シードデータの一回きりクリーンアップ (実データ運用への移行、2026-07-20):
      // DEMO_SEED_ENABLED が false の通常起動では二度とシードされないが、過去に
      // シード済みだった環境の残骸を掃除する。cleanupLegacyGoogleData と同じ流儀で
      // 起動のたびに呼んでよい(冪等・0件なら何も出さない)
      const demoCleanup = await cleanupDemoData(database)
      if (cancelled) return
      const demoTotal =
        demoCleanup.seriesRemoved + demoCleanup.occurrencesRemoved + demoCleanup.overridesRemoved
      if (demoTotal > 0) {
        console.info(
          `kichijitsu: demo data cleanup removed ${demoTotal} record(s) ` +
            `(series=${demoCleanup.seriesRemoved}, occurrences=${demoCleanup.occurrencesRemoved}, ` +
            `overrides=${demoCleanup.overridesRemoved})`,
        )
      }

      // ダミーシード投入は開発時の明示的なオプトイン (?demo=1) のときだけ (DEMO_SEED_ENABLED 参照)。
      // 実データ運用では絶対に自動投入しない
      if (DEMO_SEED_ENABLED) {
        const existingSeriesCount = await countSeries(database)
        if (existingSeriesCount === 0) {
          const series = generateDummySeries(timeZone)
          const overrides = generateDummyOverrides(series)
          const singles = generateDummyOccurrences(Temporal.Now.plainDateISO(), timeZone)
          await putSeries(database, series)
          await Promise.all(overrides.map((o) => putOverride(database, o)))
          await putOccurrences(database, singles)
        }
      }
      if (cancelled) return

      const initialRange =
        view === 'month' ? monthGridRangeMs(monthCursor, timeZone) : timelineRangeMs(timelineStart, dayCount, timeZone)
      await ensureExpanded(database, store, initialRange.fromMs, initialRange.toMs)
      if (cancelled) return

      const state = await getExpansionState(database)
      let all: Occurrence[] | undefined
      if (state) {
        all = await getOccurrencesBetween(database, state.expandedFromMs, state.expandedToMs)
      }

      // 終日予定 (フェーズ5): 展開ウィンドウの概念が無いため全件を丸ごとロードする
      const allDays = await getAllAllDayOccurrences(database)

      // occurrences と終日予定の初回反映を1回の通知にまとめ、初期描画のチラつきを防ぐ
      if (!cancelled) {
        await store.batch(async () => {
          await allDayStore.batch(async () => {
            if (all) store.load(all)
            allDayStore.load(allDays)
          })
        })
      }

      const storedVisible = await getVisibleCalendars(database)
      if (!cancelled) {
        // ここで単純に setVisibleCalendarsState(storedVisible) すると、下の
        // 「me.accounts が増えるたびにカレンダー一覧を取得する」effect が
        // (/api/me・/api/calendars は同一プロセス内の高速な往復のため) この
        // DB 読み込みより先に primary デフォルト選択を書き込んでいた場合、
        // それを空の storedVisible で握り潰してしまう(= 一生 primary が
        // 選ばれないまま {} が永続化される既知のバグだった)。
        // 既に state にある値(prev)を優先してマージすることで、どちらが
        // 先に解決してもデフォルト選択が失われないようにする
        setVisibleCalendarsState((prev) => ({ ...storedVisible, ...prev }))
        visibleCalendarsLoadedRef.current = true
      }

      if (!cancelled) setDb(database)
    }

    init().catch((err) => {
      console.error('kichijitsu: initialization failed', err)
    })

    return () => {
      cancelled = true
    }
    // 初回マウント時にのみ実行する。timelineStart/view はマウント時点の値で固定してよい
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // タイムライン/月ナビゲーション時: 表示範囲(view に応じて N日タイムライン or 6週グリッド全体)を
  // 賄うのに十分な展開が済んでいるか確認する
  useEffect(() => {
    if (!db) return
    const { fromMs, toMs } =
      view === 'month' ? monthGridRangeMs(monthCursor, timeZone) : timelineRangeMs(timelineStart, dayCount, timeZone)
    ensureExpanded(db, store, fromMs, toMs).catch((err) => {
      console.error('kichijitsu: ensureExpanded failed', err)
    })
  }, [db, view, timelineStart, dayCount, monthCursor, timeZone, store])

  // Google 連携状態を確認する。バックエンド (apps/sync) が起動していない場合の
  // fetch 失敗 / 非 2xx は「未接続」として静かに扱う(コンソールを汚さない)。
  // 起動時に1回、加えてブラウザの online イベントでも再確認する(オフライン復帰時)
  const checkMe = useCallback(async () => {
    try {
      const res = await checkedFetch('/api/me')
      if (!res.ok) {
        setMe({ connected: false, accounts: [] })
        return
      }
      const data = (await res.json()) as MeResponse
      setMe(data)
    } catch {
      setMe({ connected: false, accounts: [] })
    }
  }, [checkedFetch])

  useEffect(() => {
    checkMe()
  }, [checkMe])

  useEffect(() => {
    function onOnline() {
      checkMe()
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [checkMe])

  // visibleCalendars が変わるたびに IndexedDB meta へ永続化する。
  // 初回ロード(上の init effect)が完了するまでは待つ({} での上書きを防ぐ)
  useEffect(() => {
    if (!db || !visibleCalendarsLoadedRef.current) return
    setVisibleCalendars(db, visibleCalendars).catch((err) => {
      console.error('kichijitsu: failed to persist visibleCalendars', err)
    })
  }, [db, visibleCalendars])

  // アカウント一覧ぶんのカレンダー一覧を取得し、state に反映する共通処理。
  // 「me.accounts が増えたときの初回フェッチ」と「設定パネルを開いたときの
  // 未取得/取得失敗アカウントのリトライ」の両方から使う。
  // 初回連携時(=このアカウントの visibleCalendars が未設定)はデフォルトで primary のみ選択する
  const fetchCalendarsFor = useCallback(
    async (accounts: AccountDTO[], isCancelled: () => boolean) => {
      for (const account of accounts) {
        if (fetchInFlightRef.current.has(account.id)) continue // 並行フェッチ防止
        fetchInFlightRef.current.add(account.id)
        try {
          const res = await checkedFetch(`/api/calendars?accountId=${encodeURIComponent(account.id)}`)
          if (!res.ok) {
            throw new Error(`GET /api/calendars failed (${account.id}): ${res.status}`)
          }
          const calendars = (await res.json()) as CalendarListEntryDTO[]
          if (isCancelled()) return
          setCalendarsByAccount((prev) => ({ ...prev, [account.id]: calendars }))
          // このアカウントにまだ選択状態が無ければ primary をデフォルト選択し、
          // その場で watch も登録する(初回連携時)
          const alreadySelected = visibleCalendarsRef.current[account.id] !== undefined
          const primary = calendars.find((c) => c.primary) ?? calendars[0]
          setVisibleCalendarsState((prev) => {
            if (prev[account.id] !== undefined) return prev // 既に選択状態があるなら上書きしない
            if (!primary) return prev
            return { ...prev, [account.id]: [primary.id] }
          })
          if (!alreadySelected && primary) {
            postWatch(account.id, primary.id, true)
          }
        } catch (err) {
          console.error('kichijitsu: failed to load calendars', err)
        } finally {
          fetchInFlightRef.current.delete(account.id)
        }
      }
    },
    [checkedFetch, postWatch],
  )

  // me.accounts が増えるたびに、まだ取得していないアカウントのカレンダー一覧を取りに行く(初回のみ)
  useEffect(() => {
    const toFetch = me.accounts.filter((a) => !fetchedAccountsRef.current.has(a.id))
    if (toFetch.length === 0) return
    for (const account of toFetch) fetchedAccountsRef.current.add(account.id)

    let cancelled = false
    fetchCalendarsFor(toFetch, () => cancelled)
    return () => {
      cancelled = true
    }
  }, [me.accounts, fetchCalendarsFor])

  // 設定パネルを開いたとき、カレンダー一覧がまだ無いアカウント(未取得中、または
  // 初回フェッチが失敗して calendarsByAccount に一度もエントリが入らなかったもの)を
  // 再フェッチする。panelOpen が true になった瞬間にのみ試みる(閉じている間や、
  // 開いたままの再レンダーごとに何度も走らないよう依存を panelOpen だけに絞る)
  useEffect(() => {
    if (!panelOpen) return
    const toRetry = me.accounts.filter((a) => calendarsByAccount[a.id] === undefined)
    if (toRetry.length === 0) return
    let cancelled = false
    fetchCalendarsFor(toRetry, () => cancelled)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen])

  // 1つの (accountId, calendarId) を同期する共通処理。runSync のループと、
  // カレンダーを新規選択した直後の即時同期の両方から使う
  const syncCalendar = useCallback(
    async (accountId: string, calendarId: string, defaultColor?: string) => {
      if (!db) return
      const syncRes = await checkedFetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, calendarId } satisfies SyncRequest),
      })
      if (!syncRes.ok) {
        throw new Error(`POST /api/sync failed (${accountId}/${calendarId}): ${syncRes.status}`)
      }
      const syncData = (await syncRes.json()) as SyncResponse
      await applySyncResponse(db, store, allDayStore, syncData, { accountId, calendarId, defaultColor })
    },
    [db, store, allDayStore, checkedFetch],
  )

  // 選択中の全 (accountId, calendarId) ペア一覧(+ カレンダーのデフォルト色・primary か)。
  // 手動同期ボタン・自動同期・SSE hello 受信時の一巡 sync がいずれもこれを起点にする。
  // primary フラグは新規予定の書き込み先決定 (defaultWriteTarget、フェーズ5) にも使う
  const selectedTargets = useCallback((): WriteTargetCandidate[] => {
    const targets: WriteTargetCandidate[] = []
    for (const account of me.accounts) {
      const calendars = calendarsByAccount[account.id] ?? []
      for (const calendarId of visibleCalendars[account.id] ?? []) {
        const cal = calendars.find((c) => c.id === calendarId)
        targets.push({ accountId: account.id, calendarId, primary: cal?.primary, defaultColor: cal?.backgroundColor })
      }
    }
    return targets
  }, [me.accounts, calendarsByAccount, visibleCalendars])

  // 新規予定 (フェーズ5) のデフォルトの書き込み先: 選択中カレンダーのうち primary が
  // あればそれ、無ければ先頭 (resolveDefaultWriteTarget、規則は eventCreate.ts 参照)。
  // null なら空き領域クリック/ドラッグでの新規作成自体を無効化する (WeekGrid/DayColumn 側)
  const defaultWriteTarget = useMemo(
    () => resolveDefaultWriteTarget(selectedTargets()),
    [selectedTargets],
  )

  // 「同期」ボタン・自動同期の共通処理: 選択中の全 (accountId, calendarId) ペアを並行に同期する
  const runSync = useCallback(async () => {
    if (!db) return
    const targets = selectedTargets()
    if (targets.length === 0) return

    setSyncStatus('syncing')
    const results = await Promise.allSettled(
      targets.map((t) => syncCalendar(t.accountId, t.calendarId, t.defaultColor)),
    )
    let hadError = false
    for (const result of results) {
      if (result.status === 'rejected') {
        hadError = true
        console.error('kichijitsu: sync failed', result.reason)
      }
    }
    setSyncStatus(hadError ? 'error' : 'idle')
  }, [db, selectedTargets, syncCalendar])

  // SSE hello 受信時(接続・再接続時): 取りこぼしがあり得るため選択中カレンダーを一巡 sync する。
  // runSync と違い、同時多発を避けて直列(1件ずつ await)で回す
  const handleServerHello = useCallback(async () => {
    if (!db) return
    const targets = selectedTargets()
    if (targets.length === 0) return

    setSyncStatus('syncing')
    let hadError = false
    for (const t of targets) {
      try {
        await syncCalendar(t.accountId, t.calendarId, t.defaultColor)
      } catch (err) {
        hadError = true
        console.error('kichijitsu: SSE hello sync failed', err)
      }
    }
    setSyncStatus(hadError ? 'error' : 'idle')
  }, [db, selectedTargets, syncCalendar])

  // SSE changed 受信時: 該当 (accountId, calendarId) が選択中の場合のみ sync する
  // (通知のペイロード自体は信用せず、選択状態は常にクライアント側の visibleCalendars で判定する)
  const handleServerChanged = useCallback(
    (accountId: string, calendarId: string) => {
      if (!db) return
      if (!(visibleCalendars[accountId] ?? []).includes(calendarId)) return
      const defaultColor = calendarsByAccount[accountId]?.find((c) => c.id === calendarId)?.backgroundColor

      setSyncStatus('syncing')
      syncCalendar(accountId, calendarId, defaultColor)
        .then(() => setSyncStatus('idle'))
        .catch((err) => {
          console.error('kichijitsu: SSE changed sync failed', err)
          setSyncStatus('error')
        })
    },
    [db, visibleCalendars, calendarsByAccount, syncCalendar],
  )

  // アカウントが1つ以上連携済みの間だけ SSE (GET /api/events) に接続する。
  // hello/changed のハンドラは上の handleServerHello/handleServerChanged に委譲し、
  // 接続状態は useOffline (markOnline/markOffline) と連動させる
  useServerEvents({
    enabled: me.accounts.length > 0,
    onHello: handleServerHello,
    onChanged: handleServerChanged,
    onOpen: markOnline,
    onError: markOffline,
  })

  // 接続済み & DB 準備完了 & 選択中カレンダーが読み込まれたら起動時に1回だけ自動同期する
  useEffect(() => {
    if (!db || me.accounts.length === 0 || Object.keys(visibleCalendars).length === 0) return
    if (autoSyncedRef.current) return
    autoSyncedRef.current = true
    runSync()
  }, [db, me.accounts, visibleCalendars, runSync])

  // カレンダー設定パネルでのチェックボックス操作。選択時は即座にそのカレンダーだけ同期し、
  // 選択解除時はその (accountId, calendarId) のローカルデータを削除して store から取り除く
  const handleToggleCalendar = useCallback(
    (accountId: string, calendarId: string, nextChecked: boolean) => {
      const current = visibleCalendars[accountId] ?? []
      const nextForAccount = nextChecked
        ? current.includes(calendarId)
          ? current
          : [...current, calendarId]
        : current.filter((id) => id !== calendarId)
      setVisibleCalendarsState((prev) => ({ ...prev, [accountId]: nextForAccount }))
      postWatch(accountId, calendarId, nextChecked)

      if (!db) return

      // 選択解除では IndexedDB のデータを削除しない。表示は WeekGrid の
      // visibleCalendarKeys フィルタで隠すだけにする。削除してしまうと、
      // 再選択時にサーバーの syncToken が残っているため増分同期(変更なし=空)が返り、
      // 削除済みデータが復活せず空表示になる既知のバグだった(2026-07-20 修正)。
      // 再選択は即座に再表示され、同期の往復もちらつきも不要。実データの削除は
      // アカウント連携解除(handleDisconnectAccount)のときだけ行う。
      if (nextChecked) {
        const cal = calendarsByAccount[accountId]?.find((c) => c.id === calendarId)
        syncCalendar(accountId, calendarId, cal?.backgroundColor).catch((err) => {
          console.error('kichijitsu: failed to sync newly selected calendar', err)
        })
      }
    },
    [db, visibleCalendars, calendarsByAccount, syncCalendar, postWatch],
  )

  // アカウント単位の連携解除。サーバー側 (Google revoke + データ削除 + cookie 更新) を
  // DELETE /api/account に任せ、成功したらそのアカウントに関する状態(accounts・カレンダー一覧・
  // 選択状態・ローカルの google データ)を全て畳む。失敗時は呼び出し元(パネルの行UI)が
  // catch して表示するので、ここでは reject をそのまま伝播する
  const handleDisconnectAccount = useCallback(
    async (accountId: string) => {
      const res = await checkedFetch('/api/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId } satisfies DisconnectRequest),
      })
      if (!res.ok) {
        throw new Error(`DELETE /api/account failed: ${res.status}`)
      }

      setMe((prev) => {
        const accounts = prev.accounts.filter((a) => a.id !== accountId)
        return { connected: accounts.length > 0, accounts }
      })
      setCalendarsByAccount((prev) => {
        const { [accountId]: _removed, ...rest } = prev
        return rest
      })
      setVisibleCalendarsState((prev) => {
        const { [accountId]: _removed, ...rest } = prev
        return rest
      })
      fetchedAccountsRef.current.delete(accountId)

      if (db) {
        const { deletedOccurrenceIds, deletedAllDayIds } = await deleteGoogleData(db, (k) => k.accountId === accountId)
        store.remove(deletedOccurrenceIds)
        allDayStore.remove(deletedAllDayIds)
      }
    },
    [db, store, allDayStore, checkedFetch],
  )

  // 保存失敗の通知を数秒間表示してから消す(ツールバーの同期ステータスの流儀に倣う)
  const flashSaveError = useCallback(() => {
    if (saveErrorTimeoutRef.current !== undefined) {
      window.clearTimeout(saveErrorTimeoutRef.current)
    }
    setSaveError(true)
    saveErrorTimeoutRef.current = window.setTimeout(() => {
      setSaveError(false)
      saveErrorTimeoutRef.current = undefined
    }, 4000)
  }, [])

  useEffect(() => {
    return () => {
      if (saveErrorTimeoutRef.current !== undefined) window.clearTimeout(saveErrorTimeoutRef.current)
    }
  }, [])

  // ドラッグ確定時の永続化(フェーズ5)。store.update は WeekGrid 側で既に同期的に
  // 呼ばれている(楽観的更新)。ここでは IndexedDB への書き込みに加えて、
  // source==='google' な occurrence は POST /api/event/patch で Google へも書き戻す。
  // 書き戻しが失敗した場合(非2xx・ネットワークエラー)は store と IndexedDB を
  // 変更前の状態にロールバックし、ユーザーに数秒間通知する。
  //
  // 書き戻し成功時、正本は次の同期 (SSE changed → /api/sync) で還流してくる想定
  // (protocol.ts の EventPatchRequest コメント参照)。自分自身が書いた変更が
  // 同じ id へそのまま上書きされるだけなので、冪等であり特別な処理は不要。
  const handlePersist = useCallback(
    (updated: Occurrence, previous: Occurrence | undefined) => {
      if (!db) return
      async function run() {
        if (!db) return

        // シリーズ由来なら override を書く前に、ロールバック用に「変更前の override」を
        // 覚えておく(元々 override が無かった/別内容だったケースの両方に対応する)
        const seriesId = updated.seriesId
        const originalStartMs = updated.originalStartMs
        const overrideId =
          seriesId && originalStartMs !== undefined ? instanceId(seriesId, originalStartMs) : undefined
        const previousOverride = overrideId ? ((await getOverride(db, overrideId)) ?? null) : null

        if (overrideId && seriesId && originalStartMs !== undefined) {
          await putOverride(db, {
            id: overrideId,
            seriesId,
            originalStartMs,
            patch: { startMs: updated.startMs, endMs: updated.endMs },
          })
        }
        await putOccurrence(db, updated)

        // ローカルのみの occurrence はここまで(Google への書き戻し対象外)
        if (updated.source !== 'google') return

        const patchReq = buildEventPatchRequest(updated, timeZone)
        let ok = false
        if (patchReq) {
          try {
            const res = await checkedFetch('/api/event/patch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(patchReq),
            })
            ok = res.ok
            if (!ok) {
              console.error(`kichijitsu: POST /api/event/patch failed (${updated.id}): ${res.status}`)
            }
          } catch (err) {
            console.error('kichijitsu: POST /api/event/patch failed', err)
          }
        } else {
          console.error('kichijitsu: could not build EventPatchRequest, skipping write-back', updated.id)
        }

        if (ok) return

        // ロールバック: store・IndexedDB を変更前の状態に戻す
        if (previous) {
          store.update(previous)
          await putOccurrence(db, previous)
        }
        if (overrideId) {
          if (previousOverride) {
            await putOverride(db, previousOverride)
          } else {
            await deleteOverridesByIds(db, [overrideId])
          }
        }
        flashSaveError()
      }
      run().catch((err) => {
        console.error('kichijitsu: failed to persist occurrence update', err)
      })
    },
    [db, store, checkedFetch, timeZone, flashSaveError],
  )

  // 新規予定の楽観的作成(フェーズ5)。DayColumn(空き領域クリック/ドラッグ)がタイトルを
  // 確定した瞬間に呼ばれる。仮 id (local-pending-<uuid>) の occurrence を即座に
  // store/IndexedDB へ入れて表示し、POST /api/event/create で Google へ書き込む。
  // 成功したら仮 occurrence を確定 id (`g:<accountId>:<calendarId>:<eventId>`) の
  // occurrence に差し替える — 以後 SSE/同期で同じ予定が届いても id が一致するため
  // 冪等に上書きされるだけで済み、重複表示は起きない(eventCreate.ts のコメント参照)。
  // 失敗時は仮 occurrence を削除してロールバックし、saveError を表示する。
  const handleCreate = useCallback(
    (startMs: number, endMs: number, title: string, target: WriteTargetCandidate) => {
      if (!db) return
      const pending = buildPendingOccurrence({ title, startMs, endMs, target })
      // 楽観的表示: 応答を待たずに即座に見た目へ反映する
      store.update(pending)
      async function run() {
        if (!db) return
        await putOccurrence(db, pending)

        let ok = false
        let eventId: string | undefined
        try {
          const res = await checkedFetch('/api/event/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildEventCreateRequest({ title, startMs, endMs, target, timeZone })),
          })
          ok = res.ok
          if (ok) {
            const data = (await res.json()) as EventCreateResponse
            eventId = data.eventId
          } else {
            console.error(`kichijitsu: POST /api/event/create failed (${pending.id}): ${res.status}`)
          }
        } catch (err) {
          console.error('kichijitsu: POST /api/event/create failed', err)
        }

        if (ok && eventId) {
          const finalized = finalizeCreatedOccurrence(pending, target, eventId)
          await deleteOccurrencesByIds(db, [pending.id])
          await putOccurrence(db, finalized)
          // remove→update の間の空フレームを1回の通知にまとめる(点滅防止、他の箇所と同じ流儀)
          await store.batch(() => {
            store.remove([pending.id])
            store.update(finalized)
          })
          return
        }

        // ロールバック: 仮 occurrence を削除
        await deleteOccurrencesByIds(db, [pending.id])
        store.remove([pending.id])
        flashSaveError()
      }
      run().catch((err) => {
        console.error('kichijitsu: failed to persist new occurrence', err)
      })
    },
    [db, store, checkedFetch, timeZone, flashSaveError],
  )

  // 予定の楽観的削除(フェーズ5)。EventBlock の詳細ポップオーバーの削除ボタン(2段階確認)
  // から呼ばれる。occurrence を即座に store/IndexedDB から取り除き、シリーズ由来の
  // 1回分なら override (patch: null = EXDATE 相当、model/series.ts 参照) を書いて
  // 再展開後も現れないようにする(v1 の簡易実装: 本来は EXDATE をシリーズ側に足すのが
  // 正だが、既存の override 機構を流用する)。POST /api/event/delete で Google へ
  // 書き戻し、失敗時は occurrence(と override)を復元してロールバックし、saveError を表示する。
  // 成功後に SSE/同期で cancelled が届いても既に消えているため冪等。
  const handleDeleteOccurrence = useCallback(
    (occurrence: Occurrence) => {
      if (!db) return
      async function run() {
        if (!db) return

        const seriesId = occurrence.seriesId
        const originalStartMs = occurrence.originalStartMs
        const overrideId =
          seriesId && originalStartMs !== undefined ? instanceId(seriesId, originalStartMs) : undefined
        const previousOverride = overrideId ? ((await getOverride(db, overrideId)) ?? null) : null

        // 楽観的削除: 応答を待たずに即座に見た目から消す
        store.remove([occurrence.id])
        await deleteOccurrencesByIds(db, [occurrence.id])
        if (overrideId && seriesId && originalStartMs !== undefined) {
          await putOverride(db, { id: overrideId, seriesId, originalStartMs, patch: null })
        }

        const deleteReq = buildEventDeleteRequest(occurrence)
        let ok = false
        if (deleteReq) {
          try {
            const res = await checkedFetch('/api/event/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(deleteReq),
            })
            ok = res.ok
            if (!ok) {
              console.error(`kichijitsu: POST /api/event/delete failed (${occurrence.id}): ${res.status}`)
            }
          } catch (err) {
            console.error('kichijitsu: POST /api/event/delete failed', err)
          }
        } else {
          console.error('kichijitsu: could not build EventDeleteRequest, skipping delete', occurrence.id)
        }

        if (ok) return

        // ロールバック: occurrence と override を復元
        store.update(occurrence)
        await putOccurrence(db, occurrence)
        if (overrideId) {
          if (previousOverride) {
            await putOverride(db, previousOverride)
          } else {
            await deleteOverridesByIds(db, [overrideId])
          }
        }
        flashSaveError()
      }
      run().catch((err) => {
        console.error('kichijitsu: failed to delete occurrence', err)
      })
    },
    [db, store, checkedFetch, flashSaveError],
  )

  const withNavLock = useCallback((run: () => void) => {
    if (navLockRef.current) return
    navLockRef.current = true
    run()
    window.setTimeout(() => {
      navLockRef.current = false
    }, NAV_LOCK_MS)
  }, [])

  // ナビゲーション(←/→/今日、フェーズ6で月表示・フェーズ2でday3/day1にも対応):
  // view に応じて N日送り/月送りを切り替える(N日送りは dayGrid.ts の stepAnchor に集約)
  const goToPrev = useCallback(() => {
    withNavLock(() => {
      if (view === 'month') setMonthCursor((m) => m.subtract({ months: 1 }))
      else setTimelineStart((t) => stepAnchor(t, dayCount, -1))
    })
  }, [view, dayCount, withNavLock])

  const goToNext = useCallback(() => {
    withNavLock(() => {
      if (view === 'month') setMonthCursor((m) => m.add({ months: 1 }))
      else setTimelineStart((t) => stepAnchor(t, dayCount, 1))
    })
  }, [view, dayCount, withNavLock])

  const goToToday = useCallback(() => {
    withNavLock(() => {
      if (view === 'month') setMonthCursor(Temporal.Now.plainDateISO().with({ day: 1 }))
      else if (view === 'week') setTimelineStart(mondayOf(Temporal.Now.plainDateISO()))
      // day3/day1: 今日を先頭日にする(週ビューのように月曜へ揃える概念が無いため)
      else setTimelineStart(Temporal.Now.plainDateISO())
    })
  }, [view, withNavLock])

  // ビュー切替(週/月/3日/1日、フェーズ2でday3/day1を追加)。切替の瞬間、もう一方の状態を
  // 今表示中の期間に同期させることで、トグルしても「だいたい同じ期間を見ている」体験を保つ:
  // - タイムライン→month: 表示中の先頭日が属する月へ
  // - month→タイムライン: 表示中の月の1日へ(week だけは月曜に揃え直す)
  // - タイムライン同士(week⇔day3⇔day1): 先頭日はそのまま(dayCount の解釈だけ変わる)
  const switchView = useCallback(
    (next: View) => {
      if (view === next) return
      withNavLock(() => {
        if (next === 'month') {
          setMonthCursor(timelineStart.with({ day: 1 }))
        } else if (view === 'month') {
          setTimelineStart(next === 'week' ? mondayOf(monthCursor) : monthCursor)
        }
        setView(next)
      })
    },
    [view, timelineStart, monthCursor, withNavLock],
  )

  // 月ビューのセル空き部分・「+N」クリック(フェーズ6、フェーズ2でday1へ変更):
  // その日の day1(1日タイムライン)へ切り替える = アジェンダ的動線(docs/multiplatform.md)
  const handleNavigateToDay = useCallback(
    (day: Temporal.PlainDate) => {
      withNavLock(() => {
        setTimelineStart(day)
        setView('day1')
      })
    },
    [withNavLock],
  )

  // 'n' ショートカット(新規予定作成、フェーズ6)。理想は「今日の次の30分枠に作成入力を
  // 自動で開く」ことだが、作成入力(タイトル入力欄・draft state)は DayColumn.tsx が
  // ローカルに持っており、App からは直接開けない。ここでは簡易実装として「今日を含む
  // タイムラインビューへ移動する」にとどめ、そこから空き領域クリック/ドラッグで
  // 作成できる状態を用意する。
  // TODO: DayColumn の draft state を App まで持ち上げる(または WeekGrid に
  // 「起動時に指定 ms で作成入力を自動オープンする」imperative な API を持たせる)と、
  // 実際に入力欄まで自動で開けるようになる。
  const handleNewEventShortcut = useCallback(() => {
    if (!defaultWriteTarget) return // 書き込み先カレンダーが無ければ何もしない(ボタン起点の作成と同じ制約)
    withNavLock(() => {
      const targetView: View = view === 'month' ? (isNarrow ? 'day1' : 'week') : view
      setView(targetView)
      setTimelineStart(targetView === 'week' ? mondayOf(Temporal.Now.plainDateISO()) : Temporal.Now.plainDateISO())
    })
  }, [defaultWriteTarget, view, isNarrow, withNavLock])

  // グローバルキーボードショートカット(フェーズ6)。←/→/t は元々このハンドラが
  // 持っていたもの(WeekGrid 側は ←/→/t を処理していない、二重登録なし)に、
  // w/m/d/1/3(ビュー切替)・n(新規予定)・?(ヘルプ)・Escape(ヘルプを閉じる)を追加する。
  // キー→アクションの対応表自体は keyboard/shortcuts.ts の純関数 (resolveShortcut) に
  // 切り出してあり、テストはそちらで行う。ここでは:
  //   1. 入力中(input/textarea/contenteditable)なら常に無視
  //   2. Escape は最前面のオーバーレイ(ヘルプ)だけを閉じる。詳細ポップオーバー・設定パネルは
  //      各自の Escape リスナー (useCloseOnOutsideOrEscape / 下の panelOpen effect) が
  //      既に閉じるので、ここでは二重に処理しない
  //   3. それ以外のショートカットは、詳細ポップオーバー・設定パネル・ヘルプが開いている間は
  //      発火させない(作成入力は <input> なので 1. のガードで既にカバーされている)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      if (isEditableTarget(target?.tagName ?? null, target?.isContentEditable ?? false)) return

      const action = resolveShortcut(e, isNarrow)
      if (!action) return

      if (action.kind === 'escape') {
        if (helpOpen) setHelpOpen(false)
        return
      }

      // 他のオーバーレイ(詳細ポップオーバー・設定パネル・予定検索・ヘルプ自身など)が
      // 開いている間は無視する。個別に state/class を列挙せず role="dialog" を共通の
      // 目印にする(EventDetailCard/CalendarSettingsPanel/SearchOverlay/KeyboardHelpOverlay は
      // いずれも role="dialog" を持つ、既存の流儀)。これにより新しいオーバーレイが増えても
      // ここを更新し忘れる心配がない。
      if (document.querySelector('[role="dialog"]')) return

      switch (action.kind) {
        case 'prev':
          goToPrev()
          break
        case 'next':
          goToNext()
          break
        case 'today':
          goToToday()
          break
        case 'switchView':
          switchView(action.view)
          break
        case 'newEvent':
          handleNewEventShortcut()
          break
        case 'toggleHelp':
          setHelpOpen((v) => !v)
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [goToPrev, goToNext, goToToday, switchView, handleNewEventShortcut, isNarrow, helpOpen])

  // カレンダー設定パネル: 外側クリック・Escape で閉じる
  useEffect(() => {
    if (!panelOpen) return
    function onPointerDown(e: MouseEvent) {
      if (accountAreaRef.current && !accountAreaRef.current.contains(e.target as Node)) {
        setPanelOpen(false)
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setPanelOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [panelOpen])

  // WeekGrid に渡す「選択中カレンダー」キー集合 (`${accountId}:${calendarId}`)
  const visibleCalendarKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const [accountId, calendarIds] of Object.entries(visibleCalendars)) {
      for (const calendarId of calendarIds) keys.add(`${accountId}:${calendarId}`)
    }
    return keys
  }, [visibleCalendars])

  // EventBlock の詳細ポップオーバー用: `${accountId}:${calendarId}` → カレンダー名/色
  const calendarLookup = useMemo(() => {
    const lookup = new Map<string, CalendarInfo>()
    for (const [accountId, calendars] of Object.entries(calendarsByAccount)) {
      for (const cal of calendars) {
        lookup.set(`${accountId}:${cal.id}`, { summary: cal.summary, backgroundColor: cal.backgroundColor })
      }
    }
    return lookup
  }, [calendarsByAccount])

  // 検索結果からのジャンプ(SearchOverlay から受け取る唯一のコールバック、フェーズ6)。
  // 対象の予定を含む日へ day1 タイムラインで移動する(月表示セルクリック時の
  // handleNavigateToDay と同じ動線を再利用するだけの薄いラッパー)。
  // 将来 '/' や Cmd+K でオーバーレイを開けるようにする場合は、ショートカット側から
  // このすぐ下の openSearch を呼べばよい(今回はツールバーボタンからの起動のみ配線する)。
  const handleSearchJump = useCallback(
    (target: SearchJumpTarget) => {
      handleNavigateToDay(resolveJumpDate(target, timeZone))
    },
    [handleNavigateToDay, timeZone],
  )
  const openSearch = useCallback(() => setSearchOpen(true), [])

  return (
    <div className="app">
      <header className="toolbar">
        <div className="logo-lockup">
          <LogoMark />
          <LogoWordmark />
        </div>
        <div className="toolbar-nav">
          <button type="button" onClick={goToPrev} aria-label={view === 'week' ? '前週' : view === 'month' ? '前月' : '前へ'}>
            ←
          </button>
          <button type="button" onClick={goToToday}>
            今日
          </button>
          <button type="button" onClick={goToNext} aria-label={view === 'week' ? '次週' : view === 'month' ? '次月' : '次へ'}>
            →
          </button>
          {/* 予定検索(フェーズ6)。SearchOverlay 側で入力欄にオートフォーカスする */}
          <button type="button" onClick={openSearch} aria-label="予定を検索">
            🔍
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
                className={view === 'day1' ? 'is-active' : ''}
                aria-pressed={view === 'day1'}
                onClick={() => switchView('day1')}
              >
                1日
              </button>
              <button
                type="button"
                className={view === 'day3' ? 'is-active' : ''}
                aria-pressed={view === 'day3'}
                onClick={() => switchView('day3')}
              >
                3日
              </button>
              <button
                type="button"
                className={view === 'month' ? 'is-active' : ''}
                aria-pressed={view === 'month'}
                onClick={() => switchView('month')}
              >
                月
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={view === 'week' ? 'is-active' : ''}
                aria-pressed={view === 'week'}
                onClick={() => switchView('week')}
              >
                週
              </button>
              <button
                type="button"
                className={view === 'month' ? 'is-active' : ''}
                aria-pressed={view === 'month'}
                onClick={() => switchView('month')}
              >
                月
              </button>
            </>
          )}
        </div>
        <div className="toolbar-right">
          <span className="month-label">
            {view === 'month' ? (
              <>
                {monthCursor.year}年{monthCursor.month}月
              </>
            ) : view === 'day1' ? (
              <>
                {timelineStart.year}年{timelineStart.month}月{timelineStart.day}日
              </>
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
              オフライン
            </span>
          )}
          <div className="toolbar-account" ref={accountAreaRef}>
            {me.accounts.length > 0 ? (
              <>
                <button
                  type="button"
                  className="account-summary"
                  onClick={() => setPanelOpen((open) => !open)}
                  aria-expanded={panelOpen}
                  aria-haspopup="dialog"
                >
                  <span className="account-summary-label">
                    {me.accounts.length === 1 ? me.accounts[0].email : `${me.accounts.length}アカウント連携中`}
                  </span>
                  <span className="account-gear" aria-hidden="true">
                    ⚙
                  </span>
                </button>
                <button type="button" onClick={runSync} disabled={syncStatus === 'syncing'}>
                  {syncIndicator.visible ? (
                    <span className={syncIndicator.fading ? 'sync-indicator masu-indicator--fading' : 'sync-indicator'}>
                      <MasuIndicator size="sm" />
                      同期中
                    </span>
                  ) : (
                    '同期'
                  )}
                </button>
                {syncStatus === 'error' && <span className="sync-error">同期失敗</span>}
                {saveError && <span className="sync-error">保存失敗（元に戻しました）</span>}
                {panelOpen && (
                  <CalendarSettingsPanel
                    accounts={me.accounts}
                    calendarsByAccount={calendarsByAccount}
                    visibleCalendars={visibleCalendars}
                    onToggleCalendar={handleToggleCalendar}
                    onDisconnectAccount={handleDisconnectAccount}
                    onAddAccount={() => {
                      window.location.href = '/auth/login?add=1'
                    }}
                  />
                )}
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  window.location.href = '/auth/login'
                }}
              >
                Google 連携
              </button>
            )}
          </div>
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
          <div className="toolbar-legal">
            <a href="/privacy.html">プライバシー</a>
            <a href="/terms.html">規約</a>
          </div>
        </div>
      </header>
      <main className="app-main">
        {view !== 'month' ? (
          <WeekGrid
            store={store}
            allDayStore={allDayStore}
            weekStart={timelineStart}
            dayCount={dayCount}
            timeZone={timeZone}
            onPersist={handlePersist}
            visibleCalendarKeys={visibleCalendarKeys}
            calendarLookup={calendarLookup}
            onDelete={handleDeleteOccurrence}
            writeTarget={defaultWriteTarget}
            onCreateEvent={handleCreate}
            // モバイル対応フェーズ2: 狭幅では空き領域からの新規作成を長押し起点にする
            // (縦スクロールとの競合を避けるため。DayColumn.tsx 参照)
            longPressCreate={isNarrow}
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
            writeTarget={defaultWriteTarget}
            onCreateEvent={handleCreate}
            onNavigateToDay={handleNavigateToDay}
          />
        )}
        {initIndicator.visible && (
          <div className={initIndicator.fading ? 'init-overlay masu-indicator--fading' : 'init-overlay'}>
            <MasuIndicator size="md" />
          </div>
        )}
      </main>
      {helpOpen && <KeyboardHelpOverlay onClose={() => setHelpOpen(false)} />}
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
    </div>
  )
}

export default App
