import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, PointerEvent as ReactPointerEvent, Ref } from 'react'
import type { Occurrence } from '../model/types'
import { snapEndMs, snapStartMs } from '../layout/snap'
import { formatDetailDateTime, formatRange, formatTime, minutesToPx, pxToMinutes } from '../layout/gridMetrics'

/** カレンダー名/色。App.tsx が calendarsByAccount から `${accountId}:${calendarId}` キーで作る */
export interface CalendarInfo {
  summary: string
  backgroundColor?: string
}

interface EventBlockProps {
  occurrence: Occurrence
  /** その日の 0:00 からの px オフセット（親が packColumns の結果から計算済み） */
  top: number
  height: number
  leftPct: number
  widthPct: number
  isCompact: boolean
  timeZone: string
  /** このブロックが今属している日の週内インデックス (0=月 .. 6=日) */
  dayIndex: number
  /** このブロックが今属している日の 0:00 (epoch ms) */
  dayStartMs: number
  /** このブロックが属する週の7日ぶんの 0:00 (epoch ms)。日をまたぐ移動の着地点計算に使う */
  weekDayStarts: readonly number[]
  onCommit: (updated: Occurrence) => void
  /** `${accountId}:${calendarId}` → カレンダー名/色。詳細ポップオーバーの「どのカレンダーか」表示用 */
  calendarLookup: Map<string, CalendarInfo>
}

interface DragState {
  kind: 'move' | 'resize'
  pointerId: number
  moved: boolean
  startClientX: number
  startClientY: number
  /** ドラッグ開始時に測った、週7列グリッドの左端・上端・列幅 (px, viewport 座標) */
  gridLeft: number
  gridTop: number
  columnWidthPx: number
  /** 移動ドラッグ用: 掴んだ位置とブロック上端との差（分） */
  grabOffsetMinutes: number
  originalStartMs: number
  originalEndMs: number
  originalTopPx: number
  originalHeightPx: number
  weekDayStarts: readonly number[]
  dayStartMs: number
  pendingStartMs: number
  pendingEndMs: number
  badgeEl: HTMLDivElement
}

const CLICK_THRESHOLD_PX = 4
const HOVER_DELAY_MS = 400
const TOOLTIP_OFFSET_PX = 14

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

/**
 * ホバーツールチップは全 EventBlock で1個の DOM ノードを使い回す(drag-badge と
 * 同じ流儀: React 管理下に置かず、直接 DOM 操作で表示/非表示・位置更新する)。
 * 同時にホバーできるブロックは常に1つなので、シングルトンで十分。
 */
let sharedTooltipEl: HTMLDivElement | null = null
function getSharedTooltipEl(): HTMLDivElement {
  if (!sharedTooltipEl) {
    sharedTooltipEl = document.createElement('div')
    sharedTooltipEl.className = 'event-tooltip'
    sharedTooltipEl.style.display = 'none'
    document.body.appendChild(sharedTooltipEl)
  }
  return sharedTooltipEl
}

function positionTooltip(el: HTMLDivElement, clientX: number, clientY: number) {
  el.style.transform = `translate(${clientX + TOOLTIP_OFFSET_PX}px, ${clientY + TOOLTIP_OFFSET_PX}px)`
}

/**
 * Google の description は HTML を含み得るため、表示前にプレーンテキスト化する。
 * ブロック境界 (<br>/<p>/<div>/<li>) を改行に変換してから DOMParser でタグを剥がす
 * ("要素の textContent" は改行を保持しないため、これをしないと段落が繋がって読みにくくなる)。
 * 厳密な HTML→text 変換ではなく、詳細ポップオーバーで読める程度の簡易処理。
 */
function stripHtmlToPlainText(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n')
  const doc = new DOMParser().parseFromString(withBreaks, 'text/html')
  const text = doc.body.textContent ?? ''
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

/** 詳細ポップオーバーの想定サイズ。ビューポート外にはみ出さないようクランプするための概算値 */
const DETAIL_POPOVER_WIDTH = 300
const DETAIL_POPOVER_MAX_HEIGHT = 420
const DETAIL_POPOVER_MARGIN = 8

function clampPopoverPosition(x: number, y: number): { left: number; top: number } {
  const maxLeft = Math.max(DETAIL_POPOVER_MARGIN, window.innerWidth - DETAIL_POPOVER_WIDTH - DETAIL_POPOVER_MARGIN)
  const maxTop = Math.max(DETAIL_POPOVER_MARGIN, window.innerHeight - DETAIL_POPOVER_MAX_HEIGHT - DETAIL_POPOVER_MARGIN)
  return {
    left: clamp(x, DETAIL_POPOVER_MARGIN, maxLeft),
    top: clamp(y, DETAIL_POPOVER_MARGIN, maxTop),
  }
}

/**
 * 週グリッド上の1イベントブロック。移動・リサイズのドラッグ操作を持つ。
 *
 * 規律: pointermove 中は React の state を一切更新しない。ドラッグ中は
 * このコンポーネント自身の DOM ノードに ref 経由で直接 style を書き込み、
 * pointerup で確定した瞬間だけ onCommit (= store.update) を呼ぶ。
 */
export function EventBlock({
  occurrence,
  top,
  height,
  leftPct,
  widthPct,
  isCompact,
  timeZone,
  dayIndex,
  dayStartMs,
  weekDayStarts,
  onCommit,
  calendarLookup,
}: EventBlockProps) {
  const elRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const hoverTimeoutRef = useRef<number | undefined>(undefined)
  const tooltipShownRef = useRef(false)
  const detailCardRef = useRef<HTMLDivElement>(null)
  // クリック(≒詳細ポップオーバーを開く座標)。null の間は非表示
  const [detailPos, setDetailPos] = useState<{ x: number; y: number } | null>(null)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleKeyDown = useRef((e: KeyboardEvent) => {
    if (e.key === 'Escape') cancelDrag()
  }).current

  function createBadge(): HTMLDivElement {
    const badge = document.createElement('div')
    badge.className = 'drag-badge'
    return badge
  }

  function hideTooltip() {
    if (hoverTimeoutRef.current !== undefined) {
      window.clearTimeout(hoverTimeoutRef.current)
      hoverTimeoutRef.current = undefined
    }
    if (tooltipShownRef.current) {
      getSharedTooltipEl().style.display = 'none'
      tooltipShownRef.current = false
    }
  }

  function showTooltip(clientX: number, clientY: number) {
    const el = getSharedTooltipEl()
    el.replaceChildren()

    const titleEl = document.createElement('div')
    titleEl.className = 'event-tooltip-title'
    titleEl.textContent = occurrence.title
    el.appendChild(titleEl)

    const rangeEl = document.createElement('div')
    rangeEl.className = 'event-tooltip-range'
    rangeEl.textContent = formatRange(occurrence.startMs, occurrence.endMs, timeZone)
    el.appendChild(rangeEl)

    if (occurrence.location) {
      const locationEl = document.createElement('div')
      locationEl.className = 'event-tooltip-location'
      locationEl.textContent = occurrence.location
      el.appendChild(locationEl)
    }

    el.style.display = 'block'
    positionTooltip(el, clientX, clientY)
    tooltipShownRef.current = true
  }

  function handlePointerEnter(e: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current) return
    const clientX = e.clientX
    const clientY = e.clientY
    hoverTimeoutRef.current = window.setTimeout(() => {
      hoverTimeoutRef.current = undefined
      if (dragRef.current) return // タイマー発火までにドラッグが始まっていたら出さない
      showTooltip(clientX, clientY)
    }, HOVER_DELAY_MS)
  }

  function handlePointerLeave() {
    hideTooltip()
  }

  function cancelDrag() {
    const ds = dragRef.current
    const el = elRef.current
    if (!ds || !el) return
    window.removeEventListener('keydown', handleKeyDown)
    try {
      el.releasePointerCapture(ds.pointerId)
    } catch {
      /* すでに解放済みなら無視 */
    }
    el.classList.remove('event--dragging')
    el.style.transform = ''
    if (ds.kind === 'resize') {
      el.style.height = `${ds.originalHeightPx}px`
    }
    ds.badgeEl.remove()
    dragRef.current = null
  }

  // アンマウント時にドラッグ中なら後始末（バッジ・リスナーの残留防止）。
  // ホバー中のツールチップ(共有 DOM ノード)もこのブロック宛のままにしない
  useEffect(() => {
    return () => {
      hideTooltip()
      const ds = dragRef.current
      if (!ds) return
      window.removeEventListener('keydown', handleKeyDown)
      ds.badgeEl.remove()
      dragRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 詳細ポップオーバーが開いている間: 外側クリック・Escape で閉じる
  useEffect(() => {
    if (!detailPos) return
    function onPointerDownOutside(e: PointerEvent) {
      const card = detailCardRef.current
      if (card && !card.contains(e.target as Node)) {
        setDetailPos(null)
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setDetailPos(null)
    }
    document.addEventListener('pointerdown', onPointerDownOutside)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDownOutside)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [detailPos])

  function beginDrag(
    e: ReactPointerEvent<HTMLDivElement>,
    kind: DragState['kind'],
  ) {
    if (e.button !== 0) return
    const el = elRef.current
    const gridEl = el?.parentElement?.parentElement
    if (!el || !gridEl) return
    hideTooltip() // 操作を始めたらツールチップは即座に消す(ドラッグ中は表示しない)
    el.setPointerCapture(e.pointerId)
    const gridRect = gridEl.getBoundingClientRect()
    const columnWidthPx = gridRect.width / 7
    const grabOffsetMinutes =
      kind === 'move' ? pxToMinutes(e.clientY - gridRect.top) - pxToMinutes(top) : 0

    dragRef.current = {
      kind,
      pointerId: e.pointerId,
      moved: false,
      startClientX: e.clientX,
      startClientY: e.clientY,
      gridLeft: gridRect.left,
      gridTop: gridRect.top,
      columnWidthPx,
      grabOffsetMinutes,
      originalStartMs: occurrence.startMs,
      originalEndMs: occurrence.endMs,
      originalTopPx: top,
      originalHeightPx: height,
      weekDayStarts,
      dayStartMs,
      pendingStartMs: occurrence.startMs,
      pendingEndMs: occurrence.endMs,
      badgeEl: createBadge(),
    }
    window.addEventListener('keydown', handleKeyDown)
  }

  function handlePointerDownMove(e: ReactPointerEvent<HTMLDivElement>) {
    beginDrag(e, 'move')
  }

  function handlePointerDownResize(e: ReactPointerEvent<HTMLDivElement>) {
    e.stopPropagation()
    beginDrag(e, 'resize')
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const ds = dragRef.current
    const el = elRef.current
    if (!ds || !el || ds.pointerId !== e.pointerId) {
      // ドラッグ中でなければ、表示中のツールチップをポインタに追従させる(DOM 直書き、state 更新なし)
      if (!ds && tooltipShownRef.current) {
        positionTooltip(getSharedTooltipEl(), e.clientX, e.clientY)
      }
      return
    }

    const dx = e.clientX - ds.startClientX
    const dy = e.clientY - ds.startClientY
    if (!ds.moved && Math.hypot(dx, dy) >= CLICK_THRESHOLD_PX) {
      ds.moved = true
      el.classList.add('event--dragging')
      document.body.appendChild(ds.badgeEl)
    }
    if (!ds.moved) return

    if (ds.kind === 'move') {
      const targetIndex = clamp(
        Math.floor((e.clientX - ds.gridLeft) / ds.columnWidthPx),
        0,
        6,
      )
      const pointerMinutes = pxToMinutes(e.clientY - ds.gridTop)
      const rawStartMinutes = pointerMinutes - ds.grabOffsetMinutes
      const targetDayStartMs = ds.weekDayStarts[targetIndex]
      const rawStartMs = targetDayStartMs + rawStartMinutes * 60_000
      const snappedStart = snapStartMs(rawStartMs, {
        originalStartMs: ds.originalStartMs,
        disableSnap: e.altKey,
      })
      const durationMs = ds.originalEndMs - ds.originalStartMs
      const snappedEnd = snappedStart + durationMs

      const newTopPx = minutesToPx((snappedStart - targetDayStartMs) / 60_000)
      const dxPx = (targetIndex - dayIndex) * ds.columnWidthPx
      const dyPx = newTopPx - ds.originalTopPx
      el.style.transform = `translate(${dxPx}px, ${dyPx}px)`

      ds.pendingStartMs = snappedStart
      ds.pendingEndMs = snappedEnd
      ds.badgeEl.textContent = formatRange(snappedStart, snappedEnd, timeZone)
    } else {
      const pointerMinutes = pxToMinutes(e.clientY - ds.gridTop)
      const rawEndMs = ds.dayStartMs + pointerMinutes * 60_000
      const snappedEnd = snapEndMs(rawEndMs, ds.originalStartMs, {
        originalStartMs: ds.originalStartMs,
        disableSnap: e.altKey,
      })
      const newHeightPx = Math.max(
        minutesToPx((snappedEnd - ds.dayStartMs) / 60_000) - ds.originalTopPx,
        4,
      )
      el.style.height = `${newHeightPx}px`

      ds.pendingEndMs = snappedEnd
      ds.badgeEl.textContent = formatRange(ds.originalStartMs, snappedEnd, timeZone)
    }

    ds.badgeEl.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const ds = dragRef.current
    const el = elRef.current
    if (!ds || !el || ds.pointerId !== e.pointerId) return
    window.removeEventListener('keydown', handleKeyDown)
    try {
      el.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    ds.badgeEl.remove()

    if (!ds.moved) {
      // 移動閾値未満はクリック扱い: 詳細ポップオーバーを開く
      dragRef.current = null
      hideTooltip()
      setDetailPos({ x: e.clientX, y: e.clientY })
      return
    }

    el.classList.remove('event--dragging')
    el.style.transform = ''

    if (ds.kind === 'move') {
      onCommit({ ...occurrence, startMs: ds.pendingStartMs, endMs: ds.pendingEndMs })
    } else {
      onCommit({ ...occurrence, endMs: ds.pendingEndMs })
    }
    dragRef.current = null
  }

  function handlePointerCancel(e: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== e.pointerId) return
    cancelDrag()
  }

  // リサイズ中は height への React 再レンダーの上書きを止める。move 中に
  // 何らかの理由で親が再レンダーされても（例: 現在時刻の1分ごとの tick）、
  // 手動で書き込んだ el.style.height をこの effect 外の再レンダーで
  // 巻き戻されないようにするためのガード。top/left/width は自前で
  // 直接書き換えることがないので毎回 props の値をそのまま使ってよい。
  const isResizing = dragRef.current?.kind === 'resize'
  const style: CSSProperties = {
    top,
    left: `${leftPct}%`,
    width: `calc(${widthPct}% - 2px)`,
    backgroundColor: `${occurrence.color}26`,
    borderLeftColor: occurrence.color,
  }
  if (!isResizing) {
    style.height = height
  }

  const calendarInfo =
    occurrence.accountId && occurrence.calendarId
      ? calendarLookup.get(`${occurrence.accountId}:${occurrence.calendarId}`)
      : undefined

  return (
    <>
      <div
        ref={elRef}
        className={isCompact ? 'event event--compact' : 'event'}
        style={style}
        onPointerDown={handlePointerDownMove}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        {isCompact ? (
          <span className="event-line">
            <span className="event-time">{formatTime(occurrence.startMs, timeZone)}</span>
            <span className="event-title">{occurrence.title}</span>
          </span>
        ) : (
          <>
            <span className="event-time">{formatTime(occurrence.startMs, timeZone)}</span>
            <span className="event-title">{occurrence.title}</span>
          </>
        )}
        <div className="event-resize-handle" onPointerDown={handlePointerDownResize} />
      </div>
      {detailPos &&
        createPortal(
          <EventDetailCard
            ref={detailCardRef}
            occurrence={occurrence}
            timeZone={timeZone}
            position={detailPos}
            calendarInfo={calendarInfo}
            onClose={() => setDetailPos(null)}
          />,
          document.body,
        )}
    </>
  )
}

interface EventDetailCardProps {
  occurrence: Occurrence
  timeZone: string
  position: { x: number; y: number }
  calendarInfo?: CalendarInfo
  onClose: () => void
  /** React 19: 関数コンポーネントでも forwardRef 無しで ref を通常の prop として受け取れる */
  ref?: Ref<HTMLDivElement>
}

/**
 * クリック詳細ポップオーバー。日時・場所・説明(プレーン化+最大10行程度でクランプ)・
 * Google で開くリンク・どのカレンダーか、を表示のみで持つ(編集機能は無し)。
 * .week-grid-days-viewport (overflow:hidden) の中に transform を持つ祖先
 * (.week-grid-days-strip) がいるため、position:fixed の containing block が
 * ビューポートではなくその祖先になってしまう問題を避けるべく document.body へ
 * createPortal している。
 */
function EventDetailCard({
  occurrence,
  timeZone,
  position,
  calendarInfo,
  onClose,
  ref,
}: EventDetailCardProps) {
  const { left, top } = clampPopoverPosition(position.x, position.y)
  const plainDescription = occurrence.description ? stripHtmlToPlainText(occurrence.description) : ''

  return (
    <div
      ref={ref}
      className="event-detail-popover"
      style={{ left, top }}
      role="dialog"
      aria-label={occurrence.title}
    >
      <button type="button" className="event-detail-close" onClick={onClose} aria-label="閉じる">
        ×
      </button>
      <div className="event-detail-title">{occurrence.title}</div>
      <div className="event-detail-datetime">
        {formatDetailDateTime(occurrence.startMs, occurrence.endMs, timeZone)}
      </div>
      {occurrence.location && <div className="event-detail-location">{occurrence.location}</div>}
      {plainDescription && <div className="event-detail-description">{plainDescription}</div>}
      {occurrence.link?.url && (
        <a className="event-detail-link" href={occurrence.link.url} target="_blank" rel="noopener noreferrer">
          Google で開く
        </a>
      )}
      {calendarInfo && (
        <div className="event-detail-calendar">
          <span
            className="event-detail-calendar-dot"
            style={{ background: calendarInfo.backgroundColor ?? '#9ca3af' }}
            aria-hidden="true"
          />
          {calendarInfo.summary}
        </div>
      )}
    </div>
  )
}
