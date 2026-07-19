import { useEffect, useRef } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import type { Occurrence } from '../model/types'
import { snapEndMs, snapStartMs } from '../layout/snap'
import { formatRange, formatTime, minutesToPx, pxToMinutes } from '../layout/gridMetrics'

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

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
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
}: EventBlockProps) {
  const elRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleKeyDown = useRef((e: KeyboardEvent) => {
    if (e.key === 'Escape') cancelDrag()
  }).current

  function createBadge(): HTMLDivElement {
    const badge = document.createElement('div')
    badge.className = 'drag-badge'
    return badge
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

  // アンマウント時にドラッグ中なら後始末（バッジ・リスナーの残留防止）
  useEffect(() => {
    return () => {
      const ds = dragRef.current
      if (!ds) return
      window.removeEventListener('keydown', handleKeyDown)
      ds.badgeEl.remove()
      dragRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function beginDrag(
    e: ReactPointerEvent<HTMLDivElement>,
    kind: DragState['kind'],
  ) {
    if (e.button !== 0) return
    const el = elRef.current
    const gridEl = el?.parentElement?.parentElement
    if (!el || !gridEl) return
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
    if (!ds || !el || ds.pointerId !== e.pointerId) return

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
      // 移動閾値未満はクリック扱い。将来の詳細表示用に今は何もしない
      dragRef.current = null
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

  return (
    <div
      ref={elRef}
      className={isCompact ? 'event event--compact' : 'event'}
      style={style}
      title={occurrence.title}
      onPointerDown={handlePointerDownMove}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
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
  )
}
