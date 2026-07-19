import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Temporal } from '@js-temporal/polyfill'
import type { IDBPDatabase } from 'idb'
import type {
  AccountDTO,
  CalendarListEntryDTO,
  DisconnectRequest,
  MeResponse,
  SyncRequest,
  SyncResponse,
} from '@kichijitsu/shared'
import { WeekGrid } from './components/WeekGrid'
import { LogoMark, LogoWordmark } from './components/Logo'
import { MasuIndicator } from './components/MasuIndicator'
import { CalendarSettingsPanel } from './components/CalendarSettingsPanel'
import type { CalendarInfo } from './components/EventBlock'
import { useMasuVisible } from './hooks/useMasuVisible'
import { useOffline } from './hooks/useOffline'
import { generateDummyOccurrences, generateDummyOverrides, generateDummySeries } from './model/dummy'
import { instanceId } from './model/series'
import type { Occurrence } from './model/types'
import { OccurrenceStore } from './store/occurrenceStore'
import {
  cleanupLegacyGoogleData,
  countSeries,
  getExpansionState,
  getOccurrencesBetween,
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
import { applySyncResponse, deleteGoogleData } from './sync/applySync'
import './App.css'

/** 指定日を含む週の月曜日 */
function mondayOf(date: Temporal.PlainDate): Temporal.PlainDate {
  return date.subtract({ days: date.dayOfWeek - 1 })
}

/** 週 [weekStart, weekStart+7日) の epoch ms 範囲(timeZone の壁時計基準) */
function weekRangeMs(weekStart: Temporal.PlainDate, timeZone: string): { fromMs: number; toMs: number } {
  const fromMs = weekStart.toZonedDateTime({ timeZone }).epochMilliseconds
  const toMs = weekStart.add({ days: 7 }).toZonedDateTime({ timeZone }).epochMilliseconds
  return { fromMs, toMs }
}

// 週切替アニメーション(WeekGrid 側 SLIDE_MS=200ms)より少し長めに連打をロックする
const NAV_LOCK_MS = 220

function App() {
  const timeZone = useMemo(() => Temporal.Now.timeZoneId(), [])
  const [weekStart, setWeekStart] = useState(() => mondayOf(Temporal.Now.plainDateISO()))
  const navLockRef = useRef(false)

  const store = useMemo(() => new OccurrenceStore(), [])
  const [db, setDb] = useState<IDBPDatabase<KichijitsuDB> | null>(null)

  // マルチアカウント対応 (2026-07-19): me.accounts[] を回って各アカウントの
  // カレンダー一覧を取得し、選択中カレンダー(IndexedDB meta に永続化)ごとに同期する。
  const [me, setMe] = useState<MeResponse>({ connected: false, accounts: [] })
  const [calendarsByAccount, setCalendarsByAccount] = useState<Record<string, CalendarListEntryDTO[]>>({})
  const [visibleCalendars, setVisibleCalendarsState] = useState<VisibleCalendarsMap>({})
  const [panelOpen, setPanelOpen] = useState(false)
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'error'>('idle')
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

      const existingSeriesCount = await countSeries(database)
      if (existingSeriesCount === 0) {
        const series = generateDummySeries(timeZone)
        const overrides = generateDummyOverrides(series)
        const singles = generateDummyOccurrences(Temporal.Now.plainDateISO(), timeZone)
        await putSeries(database, series)
        await Promise.all(overrides.map((o) => putOverride(database, o)))
        await putOccurrences(database, singles)
      }
      if (cancelled) return

      const initialRange = weekRangeMs(weekStart, timeZone)
      await ensureExpanded(database, store, initialRange.fromMs, initialRange.toMs)
      if (cancelled) return

      const state = await getExpansionState(database)
      if (state) {
        const all = await getOccurrencesBetween(database, state.expandedFromMs, state.expandedToMs)
        if (!cancelled) store.load(all)
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
    // 初回マウント時にのみ実行する。weekStart はマウント時点の値で固定してよい
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 週ナビゲーション時: 表示範囲を賄うのに十分な展開が済んでいるか確認する
  useEffect(() => {
    if (!db) return
    const { fromMs, toMs } = weekRangeMs(weekStart, timeZone)
    ensureExpanded(db, store, fromMs, toMs).catch((err) => {
      console.error('kichijitsu: ensureExpanded failed', err)
    })
  }, [db, weekStart, timeZone, store])

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
          setVisibleCalendarsState((prev) => {
            if (prev[account.id] !== undefined) return prev // 既に選択状態があるなら上書きしない
            const primary = calendars.find((c) => c.primary) ?? calendars[0]
            if (!primary) return prev
            return { ...prev, [account.id]: [primary.id] }
          })
        } catch (err) {
          console.error('kichijitsu: failed to load calendars', err)
        } finally {
          fetchInFlightRef.current.delete(account.id)
        }
      }
    },
    [checkedFetch],
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
      await applySyncResponse(db, store, syncData, { accountId, calendarId, defaultColor })
    },
    [db, store, checkedFetch],
  )

  // 「同期」ボタン・自動同期の共通処理: 選択中の全 (accountId, calendarId) ペアを同期する
  const runSync = useCallback(async () => {
    if (!db) return
    const targets: { accountId: string; calendarId: string; defaultColor?: string }[] = []
    for (const account of me.accounts) {
      const calendars = calendarsByAccount[account.id] ?? []
      for (const calendarId of visibleCalendars[account.id] ?? []) {
        const cal = calendars.find((c) => c.id === calendarId)
        targets.push({ accountId: account.id, calendarId, defaultColor: cal?.backgroundColor })
      }
    }
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
  }, [db, me.accounts, calendarsByAccount, visibleCalendars, syncCalendar])

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

      if (!db) return

      if (nextChecked) {
        const cal = calendarsByAccount[accountId]?.find((c) => c.id === calendarId)
        syncCalendar(accountId, calendarId, cal?.backgroundColor).catch((err) => {
          console.error('kichijitsu: failed to sync newly selected calendar', err)
        })
      } else {
        deleteGoogleData(db, (k) => k.accountId === accountId && k.calendarId === calendarId)
          .then(({ deletedOccurrenceIds }) => {
            store.remove(deletedOccurrenceIds)
          })
          .catch((err) => {
            console.error('kichijitsu: failed to remove calendar data', err)
          })
      }
    },
    [db, visibleCalendars, calendarsByAccount, store, syncCalendar],
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
        const { deletedOccurrenceIds } = await deleteGoogleData(db, (k) => k.accountId === accountId)
        store.remove(deletedOccurrenceIds)
      }
    },
    [db, store, checkedFetch],
  )

  // ドラッグ確定時の永続化。store.update は WeekGrid 側で同期的に呼ばれる
  // (楽観的更新)。ここでは IndexedDB への書き込みだけを非同期・fire-and-forget で行う
  const handlePersist = useCallback(
    (updated: Occurrence) => {
      if (!db) return
      async function run() {
        if (!db) return
        if (updated.seriesId && updated.originalStartMs !== undefined) {
          await putOverride(db, {
            id: instanceId(updated.seriesId, updated.originalStartMs),
            seriesId: updated.seriesId,
            originalStartMs: updated.originalStartMs,
            patch: { startMs: updated.startMs, endMs: updated.endMs },
          })
        }
        await putOccurrence(db, updated)
      }
      run().catch((err) => {
        console.error('kichijitsu: failed to persist occurrence update', err)
      })
    },
    [db],
  )

  const withNavLock = useCallback((run: () => void) => {
    if (navLockRef.current) return
    navLockRef.current = true
    run()
    window.setTimeout(() => {
      navLockRef.current = false
    }, NAV_LOCK_MS)
  }, [])

  const goToPrevWeek = useCallback(() => {
    withNavLock(() => setWeekStart((w) => w.subtract({ weeks: 1 })))
  }, [withNavLock])

  const goToNextWeek = useCallback(() => {
    withNavLock(() => setWeekStart((w) => w.add({ weeks: 1 })))
  }, [withNavLock])

  const goToToday = useCallback(() => {
    withNavLock(() => setWeekStart(mondayOf(Temporal.Now.plainDateISO())))
  }, [withNavLock])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      if (e.key === 'ArrowLeft') {
        goToPrevWeek()
      } else if (e.key === 'ArrowRight') {
        goToNextWeek()
      } else if (e.key === 't' || e.key === 'T') {
        goToToday()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [goToPrevWeek, goToNextWeek, goToToday])

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

  return (
    <div className="app">
      <header className="toolbar">
        <div className="logo-lockup">
          <LogoMark />
          <LogoWordmark />
        </div>
        <div className="toolbar-nav">
          <button type="button" onClick={goToPrevWeek} aria-label="前週">
            ←
          </button>
          <button type="button" onClick={goToToday}>
            今日
          </button>
          <button type="button" onClick={goToNextWeek} aria-label="次週">
            →
          </button>
        </div>
        <div className="toolbar-right">
          <span className="month-label">
            {weekStart.year}年{weekStart.month}月
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
          <div className="toolbar-legal">
            <a href="/privacy.html">プライバシー</a>
            <a href="/terms.html">規約</a>
          </div>
        </div>
      </header>
      <main className="app-main">
        <WeekGrid
          store={store}
          weekStart={weekStart}
          timeZone={timeZone}
          onPersist={handlePersist}
          visibleCalendarKeys={visibleCalendarKeys}
          calendarLookup={calendarLookup}
        />
        {initIndicator.visible && (
          <div className={initIndicator.fading ? 'init-overlay masu-indicator--fading' : 'init-overlay'}>
            <MasuIndicator size="md" />
          </div>
        )}
      </main>
    </div>
  )
}

export default App
