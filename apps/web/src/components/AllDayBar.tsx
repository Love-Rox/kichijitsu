import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { AllDayOccurrence } from '../model/types'
import { useCloseOnOutsideOrEscape } from '../hooks/useCloseOnOutsideOrEscape'
import { formatAllDayDateRange } from '../layout/gridMetrics'
import { EventDetailCard, type CalendarInfo } from './EventBlock'
import { fillTooltipContent, getSharedTooltipEl, positionTooltip } from './eventPopoverShared'

const HOVER_DELAY_MS = 400

interface AllDayBarProps {
  /** カード上で実際に表示される代表 occurrence(集約グループの主コピー、EventBlock と同じ考え方) */
  occurrence: AllDayOccurrence
  /** この occurrence が属す集約グループの全メンバー(1件なら occurrence 自身のみ) */
  groupMembers: AllDayOccurrence[]
  /** grid-row (1-based)。packDayBars の row + 1 */
  row: number
  /** grid-column の開始 (1-based、週内 0=月なので startDayIndex+1) */
  colStart: number
  /** grid-column の終了 (exclusive、CSS Grid の line 番号なので endDayIndex+2) */
  colEnd: number
  /** `${accountId}:${calendarId}` → カレンダー名/色。ツールチップ・詳細ポップオーバーで使う */
  calendarLookup: Map<string, CalendarInfo>
}

/**
 * 終日レーンの1本の横バー(フェーズ5)。EventBlock と違いドラッグ・リサイズは
 * 対象外(表示専用)なので、pointer capture 等のドラッグ機構は一切持たない。
 * ホバーのツールチップとクリックの詳細ポップオーバーは EventBlock 側の実装
 * (共有ツールチップ DOM ノード・EventDetailCard コンポーネント)をそのまま再利用する。
 */
export function AllDayBar({ occurrence, groupMembers, row, colStart, colEnd, calendarLookup }: AllDayBarProps) {
  const hoverTimeoutRef = useRef<number | undefined>(undefined)
  const tooltipShownRef = useRef(false)
  const detailCardRef = useRef<HTMLDivElement>(null)
  const [detailPos, setDetailPos] = useState<{ x: number; y: number } | null>(null)

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
    fillTooltipContent(
      el,
      occurrence.title,
      formatAllDayDateRange(occurrence.startDate, occurrence.endDate),
      occurrence.location,
    )
    el.style.display = 'block'
    positionTooltip(el, clientX, clientY)
    tooltipShownRef.current = true
  }

  function handlePointerEnter(e: ReactPointerEvent<HTMLDivElement>) {
    const clientX = e.clientX
    const clientY = e.clientY
    hoverTimeoutRef.current = window.setTimeout(() => {
      hoverTimeoutRef.current = undefined
      showTooltip(clientX, clientY)
    }, HOVER_DELAY_MS)
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (tooltipShownRef.current) {
      positionTooltip(getSharedTooltipEl(), e.clientX, e.clientY)
    }
  }

  function handlePointerLeave() {
    hideTooltip()
  }

  function handleClick(e: ReactMouseEvent<HTMLDivElement>) {
    hideTooltip()
    setDetailPos({ x: e.clientX, y: e.clientY })
  }

  useCloseOnOutsideOrEscape(detailPos !== null, detailCardRef, () => setDetailPos(null))

  const showGroupDots = groupMembers.length > 1
  const dotColors = showGroupDots
    ? groupMembers.map((m) => {
        const info = m.accountId && m.calendarId ? calendarLookup.get(`${m.accountId}:${m.calendarId}`) : undefined
        return info?.backgroundColor ?? m.color
      })
    : []

  const style: CSSProperties = {
    gridRow: row,
    gridColumn: `${colStart} / ${colEnd}`,
    backgroundColor: `color-mix(in srgb, ${occurrence.color} 18%, white)`,
    borderLeftColor: occurrence.color,
  }

  return (
    <>
      <div
        className="allday-bar"
        style={style}
        onPointerEnter={handlePointerEnter}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onClick={handleClick}
      >
        <span className="allday-bar-title">{occurrence.title}</span>
        {showGroupDots && (
          <span className="event-group-dots" aria-hidden="true">
            {dotColors.map((c, i) => (
              <span key={i} className="event-group-dot" style={{ background: c }} />
            ))}
          </span>
        )}
      </div>
      {detailPos &&
        createPortal(
          <EventDetailCard
            ref={detailCardRef}
            subject={occurrence}
            dateTimeLabel={formatAllDayDateRange(occurrence.startDate, occurrence.endDate)}
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
