import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, PointerEvent as ReactPointerEvent, Ref } from 'react'
import type { Occurrence, OccurrenceLink } from '../model/types'
import { snapEndMs, snapStartMs } from '../layout/snap'
import { useCloseOnOutsideOrEscape } from '../hooks/useCloseOnOutsideOrEscape'
import {
  clampPopoverPosition,
  fillTooltipContent,
  getSharedTooltipEl,
  positionTooltip,
  stripHtmlToPlainText,
} from './eventPopoverShared'
import {
  DAY_COLUMN_INSET_PX,
  formatDetailDateTime,
  formatRange,
  formatTime,
  isBusyPlaceholder,
  minutesToPx,
  pxToMinutes,
} from '../layout/gridMetrics'
import { buildCalendarStripeColors, resolveBusyColor } from '../layout/eventColors'

/** カレンダー名/色。App.tsx が calendarsByAccount から `${accountId}:${calendarId}` キーで作る */
export interface CalendarInfo {
  summary: string
  backgroundColor?: string
}

interface EventBlockProps {
  /** カード上で実際に操作対象になる代表 occurrence(集約グループの主コピー) */
  occurrence: Occurrence
  /**
   * この occurrence が属す集約グループの全メンバー(フェーズ5の同一予定集約)。
   * 1件なら occurrence 自身のみを含む配列。2件以上でカード上に色ドットを表示し、
   * 詳細ポップオーバーで全所属を列挙する
   */
  groupMembers: Occurrence[]
  /** その日の 0:00 からの px オフセット（親が packColumns の結果から計算済み） */
  top: number
  height: number
  /** 使用可能幅(日列の左右インセットを除いた内側)に対する % (0-100)。カスケード表示の座標 */
  leftPct: number
  widthPct: number
  /** カスケード表示の重なり順(0-based 列番号)。z-index の基準にする */
  stackIndex: number
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

/**
 * 週7列グリッドの左端からのドラッグ着地列を [0,6] に収めるためだけの、
 * このファイル内限定のクランプ(共有版は eventPopoverShared.ts の
 * clampPopoverPosition が内部で使っている別インスタンス)。
 */
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
  groupMembers,
  top,
  height,
  leftPct,
  widthPct,
  stackIndex,
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
    fillTooltipContent(el, occurrence.title, formatRange(occurrence.startMs, occurrence.endMs, timeZone), occurrence.location)
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

  // 詳細ポップオーバーが開いている間: 外側クリック・Escape で閉じる(AllDayBar と共通の hook)
  useCloseOnOutsideOrEscape(detailPos !== null, detailCardRef, () => setDetailPos(null))

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
  // カスケード表示(フェーズ5): leftPct/widthPct は「日列の左右インセットを除いた
  // 使用可能幅」に対する % (WeekGrid 側で計算済み)。px のインセットと % を
  // calc() で組み合わせ、予定が日の仕切り線に密着しないようにする
  // Busy/予定あり は中身の無い「ブロックされた時間」。実予定と区別できるよう
  // 斜線ハッチの控えめな見た目にする(.event--busy)が、そのカレンダーの色を
  // 使ったハッチにする(2026-07-20 ユーザー決定)。左ボーダーとハッチの斜線の
  // 両方に使う色を --busy-color として CSS へ渡し、.event--busy 側の
  // repeating-linear-gradient がそれを参照する。色が解決できない/不正なら
  // resolveBusyColor が従来のグレーにフォールバックする。
  const isBusy = isBusyPlaceholder(occurrence.title)
  const busyColor = isBusy ? resolveBusyColor(occurrence, calendarLookup) : undefined
  const usableWidthExpr = `(100% - ${DAY_COLUMN_INSET_PX * 2}px)`

  // 同一予定の集約(フェーズ5〜6): 2件以上の複製がある場合、左端に所属カレンダー
  // ぶんの色ストライプを並べて「複数カレンダーにまたがっている」ことを一目で
  // 分かるようにする(単一メンバー時は従来通り単色の左ボーダーのまま)。
  const stripeColors = groupMembers.length > 1 ? buildCalendarStripeColors(groupMembers, calendarLookup) : []
  const hasStripes = stripeColors.length > 0
  const STRIPE_WIDTH_PX = 3
  const STRIPE_CONTENT_GAP_PX = 4 // .event の既定 padding-left (4px) と揃える

  const style: CSSProperties = {
    top,
    left: `calc(${DAY_COLUMN_INSET_PX}px + ${usableWidthExpr} * ${leftPct / 100})`,
    width: `calc(${usableWidthExpr} * ${widthPct / 100})`,
    zIndex: stackIndex + 1,
    // カスケード重ね (2026-07-20) 以降、背景は不透明必須: 半透明 (`${color}26`) だと
    // 重なった下のカードの文字が透けて読めなくなる。色味は同等のまま白と混合して不透明化。
    // Busy は背景を独自指定せず、色付きハッチ(CSS 側 .event--busy + --busy-color)に任せる。
    ...(isBusy
      ? ({ borderLeftColor: busyColor, '--busy-color': busyColor } as CSSProperties)
      : {
          backgroundColor: `color-mix(in srgb, ${occurrence.color} 15%, white)`,
          borderLeftColor: occurrence.color,
        }),
    // ストライプ表示時は単色の左ボーダーを消し、そのぶんテキストの開始位置を右へ押し出す
    ...(hasStripes
      ? {
          borderLeft: 'none',
          paddingLeft: `${stripeColors.length * STRIPE_WIDTH_PX + STRIPE_CONTENT_GAP_PX}px`,
        }
      : {}),
  }
  if (!isResizing) {
    style.height = height
  }

  return (
    <>
      <div
        ref={elRef}
        className={[
          'event',
          isCompact ? 'event--compact' : '',
          isBusy ? 'event--busy' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={style}
        onPointerDown={handlePointerDownMove}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        {hasStripes && (
          // 集約カードの「複数カレンダーにまたがっている」印。ドラッグ/クリックの
          // 判定を奪わないよう pointer-events:none(CSS 側)にしてある
          <span className="event-cal-stripes" aria-hidden="true">
            {stripeColors.map((c, i) => (
              <span key={i} className="event-cal-stripe" style={{ background: c }} />
            ))}
          </span>
        )}
        {isCompact ? (
          <span className="event-line">
            <span className="event-time">{formatTime(occurrence.startMs, timeZone)}</span>
            <span className="event-title">{occurrence.title}</span>
          </span>
        ) : (
          <>
            <span className="event-header-row">
              <span className="event-time">{formatTime(occurrence.startMs, timeZone)}</span>
            </span>
            <span className="event-title">{occurrence.title}</span>
          </>
        )}
        <div className="event-resize-handle" onPointerDown={handlePointerDownResize} />
      </div>
      {detailPos &&
        createPortal(
          <EventDetailCard
            ref={detailCardRef}
            subject={occurrence}
            dateTimeLabel={formatDetailDateTime(occurrence.startMs, occurrence.endMs, timeZone)}
            position={detailPos}
            groupMembers={groupMembers}
            calendarLookup={calendarLookup}
            onClose={() => setDetailPos(null)}
          />,
          document.body,
        )}
    </>
  )
}

/**
 * EventDetailCard が要求する最小限の形。Occurrence (時刻予定) と AllDayOccurrence
 * (終日予定、フェーズ5) はどちらもこの形を構造的に満たすため、変換なしでそのまま
 * subject/groupMembers に渡せる(AllDayBar.tsx から再利用する狙い)。
 */
export interface EventDetailSubject {
  id: string
  title: string
  location?: string
  description?: string
  link?: OccurrenceLink
  accountId?: string
  calendarId?: string
}

export interface EventDetailCardProps {
  subject: EventDetailSubject
  /** 表示済みの日時ラベル。時刻予定は「7月20日(月) 10:00 – 11:00」、終日予定は
   * 「7月20日〜7月22日」のように呼び出し側でフォーマットしてから渡す */
  dateTimeLabel: string
  position: { x: number; y: number }
  /** 集約グループの全メンバー(フェーズ5)。1件なら subject 自身のみ */
  groupMembers: EventDetailSubject[]
  /** `${accountId}:${calendarId}` → カレンダー名/色。全所属の列挙に使う */
  calendarLookup: Map<string, CalendarInfo>
  onClose: () => void
  /** React 19: 関数コンポーネントでも forwardRef 無しで ref を通常の prop として受け取れる */
  ref?: Ref<HTMLDivElement>
}

/**
 * クリック詳細ポップオーバー。日時・場所・説明(プレーン化+最大10行程度でクランプ)・
 * Google で開くリンク・どのカレンダーか、を表示のみで持つ(編集機能は無し)。
 * 同一予定の集約(フェーズ5)で複数アカウント/カレンダーに重複がある場合は、
 * 全所属をカレンダー名の列で列挙する(groupMembers が2件以上のとき)。
 * .week-grid-days-viewport (overflow:hidden) の中に transform を持つ祖先
 * (.week-grid-days-strip) がいるため、position:fixed の containing block が
 * ビューポートではなくその祖先になってしまう問題を避けるべく document.body へ
 * createPortal している。
 * subject/dateTimeLabel を汎用化してあるため AllDayBar.tsx (終日レーン、フェーズ5)
 * からもそのまま再利用する。
 */
export function EventDetailCard({
  subject,
  dateTimeLabel,
  position,
  groupMembers,
  calendarLookup,
  onClose,
  ref,
}: EventDetailCardProps) {
  const { left, top } = clampPopoverPosition(position.x, position.y)
  const plainDescription = subject.description ? stripHtmlToPlainText(subject.description) : ''
  const memberCalendars = groupMembers
    .map((m) => {
      const info = m.accountId && m.calendarId ? calendarLookup.get(`${m.accountId}:${m.calendarId}`) : undefined
      return info ? { key: m.id, color: info.backgroundColor ?? '#9ca3af', summary: info.summary } : null
    })
    .filter((info) => info !== null)

  return (
    <div
      ref={ref}
      className="event-detail-popover"
      style={{ left, top }}
      role="dialog"
      aria-label={subject.title}
    >
      <button type="button" className="event-detail-close" onClick={onClose} aria-label="閉じる">
        ×
      </button>
      <div className="event-detail-title">{subject.title}</div>
      <div className="event-detail-datetime">{dateTimeLabel}</div>
      {subject.location && <div className="event-detail-location">{subject.location}</div>}
      {plainDescription && <div className="event-detail-description">{plainDescription}</div>}
      {subject.link?.url && (
        <a className="event-detail-link" href={subject.link.url} target="_blank" rel="noopener noreferrer">
          Google で開く
        </a>
      )}
      {memberCalendars.length > 0 && (
        <div className="event-detail-calendar-list">
          {memberCalendars.map((info) => (
            <div className="event-detail-calendar" key={info.key}>
              <span
                className="event-detail-calendar-dot"
                style={{ background: info.color }}
                aria-hidden="true"
              />
              {info.summary}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
