import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { AllDayOccurrence } from "../model/types";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import { formatAllDayDateRange } from "../layout/gridMetrics";
import { EventDetailCard, type CalendarInfo } from "./EventBlock";
import { fillTooltipContent, getSharedTooltipEl, positionTooltip } from "./eventPopoverShared";
import { resolveDisplayColor } from "../layout/eventColors";
import { PlaceIcon } from "./icons";

const HOVER_DELAY_MS = 400;

interface AllDayBarProps {
  /** カード上で実際に表示される代表 occurrence(集約グループの主コピー、EventBlock と同じ考え方) */
  occurrence: AllDayOccurrence;
  /** この occurrence が属す集約グループの全メンバー(1件なら occurrence 自身のみ) */
  groupMembers: AllDayOccurrence[];
  /** grid-row (1-based)。packDayBars の row + 1 */
  row: number;
  /** grid-column の開始 (1-based、週内 0=月なので startDayIndex+1) */
  colStart: number;
  /** grid-column の終了 (exclusive、CSS Grid の line 番号なので endDayIndex+2) */
  colEnd: number;
  /** `${accountId}:${calendarId}` → カレンダー名/色。ツールチップ・詳細ポップオーバーで使う */
  calendarLookup: Map<string, CalendarInfo>;
}

/**
 * 終日レーンの1本の横バー(フェーズ5)。EventBlock と違いドラッグ・リサイズは
 * 対象外(表示専用)なので、pointer capture 等のドラッグ機構は一切持たない。
 * ホバーのツールチップとクリックの詳細ポップオーバーは EventBlock 側の実装
 * (共有ツールチップ DOM ノード・EventDetailCard コンポーネント)をそのまま再利用する。
 */
export function AllDayBar({
  occurrence,
  groupMembers,
  row,
  colStart,
  colEnd,
  calendarLookup,
}: AllDayBarProps) {
  const hoverTimeoutRef = useRef<number | undefined>(undefined);
  const tooltipShownRef = useRef(false);
  const detailCardRef = useRef<HTMLDivElement>(null);
  const [detailPos, setDetailPos] = useState<{ x: number; y: number } | null>(null);

  function hideTooltip() {
    if (hoverTimeoutRef.current !== undefined) {
      window.clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = undefined;
    }
    if (tooltipShownRef.current) {
      getSharedTooltipEl().style.display = "none";
      tooltipShownRef.current = false;
    }
  }

  function showTooltip(clientX: number, clientY: number) {
    const el = getSharedTooltipEl();
    fillTooltipContent(
      el,
      occurrence.title,
      formatAllDayDateRange(occurrence.startDate, occurrence.endDate),
      occurrence.location,
    );
    el.style.display = "block";
    positionTooltip(el, clientX, clientY);
    tooltipShownRef.current = true;
  }

  function handlePointerEnter(e: ReactPointerEvent<HTMLDivElement>) {
    const clientX = e.clientX;
    const clientY = e.clientY;
    hoverTimeoutRef.current = window.setTimeout(() => {
      hoverTimeoutRef.current = undefined;
      showTooltip(clientX, clientY);
    }, HOVER_DELAY_MS);
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (tooltipShownRef.current) {
      positionTooltip(getSharedTooltipEl(), e.clientX, e.clientY);
    }
  }

  function handlePointerLeave() {
    hideTooltip();
  }

  function handleClick(e: ReactMouseEvent<HTMLDivElement>) {
    hideTooltip();
    setDetailPos({ x: e.clientX, y: e.clientY });
  }

  useCloseOnOutsideOrEscape(detailPos !== null, detailCardRef, () => setDetailPos(null));

  const showGroupDots = groupMembers.length > 1;
  const dotColors = showGroupDots
    ? groupMembers.map((m) => resolveDisplayColor(m, calendarLookup))
    : [];

  // 表示色バグ修正 (2026-07-20): EventBlock と同様、生の occurrence.color ではなく
  // resolveDisplayColor で解決する(hasCustomColor が無ければ calendarLookup のカレンダー色を優先)
  const displayColor = resolveDisplayColor(occurrence, calendarLookup);
  // 勤務場所の控えめ表示 (2026-07-22、ユーザー要望「主張しすぎ。他の予定を邪魔しないくらいに」)。
  // 勤務場所はほぼ終日イベントとして届くため、ここ(AllDayBar)が主戦場になる ―― isOutOfOffice の
  // ような専用レール分離はせず(要件どおり packDayBars の通常の行詰めに任せる)、通常チップと
  // 同じ位置に描くが、色チップ・左ボーダー・背景を一切持たない薄墨の小テキストのみにする。
  // RSVP 装飾(declined/needsAction)とは通常同時に起きない想定だが、見た目の優先順位を明確に
  // するため排他にしておく(isBusy が RSVP を上書きする EventBlock と同じ考え方)。
  const isWorkingLocation = occurrence.isWorkingLocation === true;
  // 参加ステータス表示 (RSVP、2026-07-22)。EventBlock/MonthView と対になる最小限の表現
  // (要件: declined の line-through+淡色、needsAction の輪郭表現のみ)。ここに渡る occurrence は
  // WeekGrid 側で不在(OOO)分を既に分離済み(splitOutOfOfficeAllDayGroups)なので、isOutOfOffice
  // との排他判定は不要(EventBlock/MonthView と違い isOoo チェックを持たない)。
  const isDeclined = !isWorkingLocation && occurrence.responseStatus === "declined";
  const isNeedsAction = !isWorkingLocation && occurrence.responseStatus === "needsAction";
  const style: CSSProperties = {
    gridRow: row,
    gridColumn: `${colStart} / ${colEnd}`,
    ...(isWorkingLocation
      ? {}
      : isNeedsAction
        ? ({ "--rsvp-color": displayColor } as CSSProperties)
        : {
            backgroundColor: `color-mix(in srgb, ${displayColor} 18%, white)`,
            borderLeftColor: displayColor,
          }),
  };

  return (
    <>
      <div
        className={[
          "allday-bar",
          isDeclined ? "allday-bar--declined" : "",
          isNeedsAction ? "allday-bar--needs-action" : "",
          isWorkingLocation ? "allday-bar--working-location" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={style}
        onPointerEnter={handlePointerEnter}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onClick={handleClick}
      >
        <span className="allday-bar-title">
          {isWorkingLocation && <PlaceIcon width={10} height={10} />}
          {occurrence.title}
        </span>
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
  );
}
