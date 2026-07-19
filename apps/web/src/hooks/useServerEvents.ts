import { useEffect, useRef } from 'react'
import type { ServerEvent } from '@kichijitsu/shared'

/** changed イベントのバースト対策: 同じ (accountId, calendarId) の連続 changed をまとめる待ち時間 */
const CHANGED_DEBOUNCE_MS = 2000

export interface ServerEventHandlers {
  /** SSE 接続時/再接続時に1回発火。取りこぼしがあり得るため選択中カレンダーを一巡 sync すること */
  onHello: () => void
  /** 該当 (accountId, calendarId) の変更通知。選択中なら sync すること(ペイロード自体は信用しない) */
  onChanged: (accountId: string, calendarId: string) => void
}

export interface UseServerEventsOptions extends ServerEventHandlers {
  /** 接続条件(App.tsx: アカウントが1つ以上連携済み)。false の間は EventSource を張らない */
  enabled: boolean
  /** EventSource の 'open' (接続成功/再接続成功) で呼ぶ。useOffline の markOnline 相当を渡す想定 */
  onOpen?: () => void
  /** EventSource の 'error' で呼ぶ。useOffline の markOffline 相当を渡す想定 */
  onError?: () => void
}

/**
 * (accountId, calendarId) をキーに changed の連投をデバウンスする。
 * 同じキーで schedule() が連続で呼ばれた場合、最後の呼び出しから delayMs 後に
 * dispatch を1回だけ呼ぶ(バーストで何度も sync が走るのを防ぐ)。
 *
 * React から独立した純粋なロジックとして切り出してあるのは、jsdom 等を追加せずに
 * fake timers だけでユニットテストできるようにするため(useServerEvents.test.ts 参照)。
 */
export function createChangedDebouncer(
  dispatch: (accountId: string, calendarId: string) => void,
  delayMs = CHANGED_DEBOUNCE_MS,
): { schedule: (accountId: string, calendarId: string) => void; clear: () => void } {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function schedule(accountId: string, calendarId: string): void {
    const key = `${accountId}:${calendarId}`
    const existing = timers.get(key)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      timers.delete(key)
      dispatch(accountId, calendarId)
    }, delayMs)
    timers.set(key, timer)
  }

  function clear(): void {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }

  return { schedule, clear }
}

/**
 * SSE の1メッセージ (MessageEvent.data、JSON文字列) を ServerEvent にパースする。
 * 壊れた/想定外の payload は null を返し、呼び出し側は無視してよい
 * (通知のペイロードを信用しない原則 — protocol.ts の ServerEvent コメント参照)。
 */
export function parseServerEvent(raw: string): ServerEvent | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown> | null
    if (!data || typeof data !== 'object') return null
    if (data.type === 'hello') return { type: 'hello' }
    if (data.type === 'changed' && typeof data.accountId === 'string' && typeof data.calendarId === 'string') {
      return { type: 'changed', accountId: data.accountId, calendarId: data.calendarId }
    }
    return null
  } catch {
    return null
  }
}

/** EventSource 本体・テスト用フェイクの双方が満たせる最小限のインターフェース */
export interface EventSourceLike {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

/**
 * EventSourceLike に hello/changed のディスパッチを配線する。
 * changed は createChangedDebouncer 経由でまとめてから onChanged を呼ぶ。
 * 戻り値の関数はリスナー解除 + デバウンスタイマーの掃除を行う(呼び出し側は接続を
 * 閉じる直前に呼ぶこと)。
 */
export function attachServerEventListeners(es: EventSourceLike, handlers: ServerEventHandlers): () => void {
  const debouncer = createChangedDebouncer(handlers.onChanged)

  function onMessage(event: MessageEvent): void {
    const parsed = parseServerEvent(event.data as string)
    if (!parsed) return
    if (parsed.type === 'hello') {
      handlers.onHello()
    } else {
      debouncer.schedule(parsed.accountId, parsed.calendarId)
    }
  }

  es.addEventListener('message', onMessage)

  return () => {
    es.removeEventListener('message', onMessage)
    debouncer.clear()
  }
}

/**
 * GET /api/events (SSE) に接続し、hello/changed をコールバックへ橋渡しするフック。
 *
 * - 接続条件は enabled(呼び出し側: アカウント連携済み)
 * - 再接続は EventSource の標準挙動に任せる(自前バックオフは実装しない)。
 *   Last-Event-ID による取りこぼし分の再送もブラウザが自動で行う
 * - バックエンド未起動/接続失敗でもコンソールを荒らさない: error は接続1回につき1回だけ
 *   ログし、open で再び接続できたらログ状態をリセットする(以後の失敗はまた1回だけ出す)
 */
export function useServerEvents(options: UseServerEventsOptions): void {
  const { enabled, onHello, onChanged, onOpen, onError } = options
  // イベントハンドラを ref に逃がし、effect の再実行(= EventSource の張り直し)を
  // enabled の変化だけに絞る(onHello 等はレンダーごとに新しい参照になり得るため)
  const handlersRef = useRef({ onHello, onChanged, onOpen, onError })
  handlersRef.current = { onHello, onChanged, onOpen, onError }

  useEffect(() => {
    if (!enabled) return
    if (typeof EventSource === 'undefined') return

    const es = new EventSource('/api/events')
    let loggedError = false

    function handleOpen(): void {
      loggedError = false
      handlersRef.current.onOpen?.()
    }

    function handleError(): void {
      if (!loggedError) {
        loggedError = true
        console.error('kichijitsu: SSE /api/events connection error (auto-retrying)')
      }
      handlersRef.current.onError?.()
    }

    es.addEventListener('open', handleOpen)
    es.addEventListener('error', handleError)
    const detach = attachServerEventListeners(es, {
      onHello: () => handlersRef.current.onHello(),
      onChanged: (accountId, calendarId) => handlersRef.current.onChanged(accountId, calendarId),
    })

    return () => {
      es.removeEventListener('open', handleOpen)
      es.removeEventListener('error', handleError)
      detach()
      es.close()
    }
  }, [enabled])
}
