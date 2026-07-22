import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { AllDayOccurrence, Occurrence } from "../model/types";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import {
  formatAllDayDateRange,
  formatDetailDateTime,
  formatRange,
  minutesToPx,
} from "../layout/gridMetrics";
import type { WorkingLocationRailItem } from "../layout/workingLocationRail";
import { EventDetailCard, type CalendarInfo } from "./EventBlock";
import { fillTooltipContent, getSharedTooltipEl, positionTooltip } from "./eventPopoverShared";
import { PlaceIcon } from "./icons";

const HOVER_DELAY_MS = 400;
const PIN_ICON_SIZE_PX = 12;

/** WorkingLocationRailItem.subject が時刻予定(Occurrence)かどうかの構造的ガード(OooRailLine.tsx と同じ) */
function isTimedSubject(subject: Occurrence | AllDayOccurrence): subject is Occurrence {
  return "startMs" in subject;
}

interface WorkingLocationRailPinProps {
  item: WorkingLocationRailItem;
  timeZone: string;
  /** `${accountId}:${calendarId}` → カレンダー名/色。EventDetailCard の全所属列挙に使う */
  calendarLookup: Map<string, CalendarInfo>;
}

/**
 * 勤務場所(workingLocation)レールの1本(DayColumn.tsx から使う、2026-07-22 作り直し)。
 *
 * OooRailLine.tsx とほぼ同じフォーム(表示専用・ドラッグ無し、ホバーは eventPopoverShared.ts
 * の共有ツールチップ、クリック/タップは EventDetailCard の再利用、subject は時刻予定/終日
 * 予定どちらもありうる)だが、バーではなく PlaceIcon の点ピンとして描く ―― 勤務場所は
 * 「その日どこで働くか」という一点の情報であって占有時間ではないため。
 * item.topMinutes が時刻予定なら開始時刻、終日予定なら常に 0(日カラム上端固定)を表す。
 *
 * 「地図で開く」リンクは付けない(ユーザー決定、2026-07-22 作り直し): 勤務場所の title
 * (例: 自宅/オフィス)は住所とは限らないため、Google マップ検索に投げても正しい結果に
 * ならないことがある。直前のコミット(location フィールド版)にはこのリンクがあったが、
 * それは対象が「location を持つ実在の予定」だったから成立していた ―― 勤務場所とは前提が
 * 違う。将来 location フィールドが別途あるケースが分かれば再検討の余地はある。
 *
 * 色は朱(--logo-aka)を使わない(OOO/旧 location レールと同じ決定)。ピンの色は
 * WeekGrid.css 側で薄墨系(#8a8478、ホバーで #24211e)に固定する。
 */
export function WorkingLocationRailPin({
  item,
  timeZone,
  calendarLookup,
}: WorkingLocationRailPinProps) {
  const hoverTimeoutRef = useRef<number | undefined>(undefined);
  const tooltipShownRef = useRef(false);
  const detailCardRef = useRef<HTMLDivElement>(null);
  const [detailPos, setDetailPos] = useState<{ x: number; y: number } | null>(null);

  const { subject, groupMembers } = item;

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
    // 勤務場所の「場所」は title 自体が表す(例: 自宅/オフィス、要件どおり)。location
    // フィールドは勤務場所では通常使わないため、ツールチップの補足行には出さない。
    const rangeLabel = isTimedSubject(subject)
      ? formatRange(subject.startMs, subject.endMs, timeZone)
      : formatAllDayDateRange(subject.startDate, subject.endDate);
    fillTooltipContent(el, subject.title, rangeLabel);
    el.style.display = "block";
    positionTooltip(el, clientX, clientY);
    tooltipShownRef.current = true;
  }

  // pointerenter/leave/move によるホバーツールチップは OooRailLine.tsx と同一の実装
  // (ドラッグを持たないので EventBlock のような dragRef ガードは不要)
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

  // クリック(デスクトップ)・タップ(タッチ)のどちらもこの1本の onClick で受ける
  // (OooRailLine.tsx と同じ流儀。この要素自体がドラッグ不可のため click/drag 判別は不要)
  function handleClick(e: ReactMouseEvent<HTMLDivElement>) {
    hideTooltip();
    setDetailPos({ x: e.clientX, y: e.clientY });
  }

  useCloseOnOutsideOrEscape(detailPos !== null, detailCardRef, () => setDetailPos(null));

  const dateTimeLabel = isTimedSubject(subject)
    ? formatDetailDateTime(subject.startMs, subject.endMs, timeZone)
    : formatAllDayDateRange(subject.startDate, subject.endDate);

  return (
    <>
      <div
        className="day-workloc-pin"
        style={{ top: minutesToPx(item.topMinutes) }}
        onPointerEnter={handlePointerEnter}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onClick={handleClick}
      >
        <PlaceIcon width={PIN_ICON_SIZE_PX} height={PIN_ICON_SIZE_PX} />
      </div>
      {detailPos &&
        createPortal(
          <EventDetailCard
            ref={detailCardRef}
            subject={subject}
            dateTimeLabel={dateTimeLabel}
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
