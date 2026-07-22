import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import { formatDetailDateTime, formatRange, minutesToPx } from "../layout/gridMetrics";
import type { LocationRailItem } from "../layout/locationRail";
import { EventDetailCard, type CalendarInfo } from "./EventBlock";
import { fillTooltipContent, getSharedTooltipEl, positionTooltip } from "./eventPopoverShared";
import { PlaceIcon } from "./icons";

const HOVER_DELAY_MS = 400;
const PIN_ICON_SIZE_PX = 12;

interface LocationRailPinProps {
  item: LocationRailItem;
  timeZone: string;
  /** `${accountId}:${calendarId}` → カレンダー名/色。EventDetailCard の全所属列挙に使う */
  calendarLookup: Map<string, CalendarInfo>;
}

/**
 * 場所付き予定レール(地図ピン表示、2026-07-22)の1本(DayColumn.tsx から使う)。
 *
 * OooRailLine.tsx とほぼ同じフォーム(表示専用・ドラッグ無し、ホバーは eventPopoverShared.ts
 * の共有ツールチップ、クリック/タップは EventDetailCard の再利用)だが、決定的に違う点が2つ:
 *   - OOO は予定カードの代わりにレールへ「振り分ける」ものだが、場所付き予定は実在の予定
 *     なのでカード自体は EventBlock 側でそのまま描画され続ける。このピンはその隣に立つ
 *     補助的な「一覧」用の目印にすぎない(subject は常に Occurrence 単体、集約グループの
 *     概念を持たない ―― groupMembers は EventDetailCard へ [subject] のみを渡す)。
 *   - 詳細ポップオーバーに「地図で開く」リンク(Google マップ検索、mapLink)を追加で渡す。
 *     これは EventBlock/OooRailLine の通常の詳細ポップオーバーには出ない、このレール限定の
 *     追加導線(ユーザー要件)。
 *
 * 色は朱(--logo-aka)を使わない(ユーザー決定:朱はブランドの唯一のアクセント)。ピンの色は
 * WeekGrid.css 側で薄墨系(#8a8478、ホバーで #24211e)に固定する。
 */
export function LocationRailPin({ item, timeZone, calendarLookup }: LocationRailPinProps) {
  const hoverTimeoutRef = useRef<number | undefined>(undefined);
  const tooltipShownRef = useRef(false);
  const detailCardRef = useRef<HTMLDivElement>(null);
  const [detailPos, setDetailPos] = useState<{ x: number; y: number } | null>(null);

  const { subject } = item;

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
      subject.title,
      formatRange(subject.startMs, subject.endMs, timeZone),
      subject.location,
    );
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

  const dateTimeLabel = formatDetailDateTime(subject.startMs, subject.endMs, timeZone);
  // Google マップの検索 URL(座標ではなく location 文字列そのままの検索リンク、ユーザー決定)。
  // locationRailItems() が location 非空を保証してこの item を作っているが、Occurrence.location
  // は型上 optional なのでここでも undefined ガードしておく
  const mapLink = subject.location
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(subject.location)}`
    : undefined;

  return (
    <>
      <div
        className="day-location-pin"
        style={{ top: minutesToPx(item.startMinutes) }}
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
            groupMembers={[subject]}
            calendarLookup={calendarLookup}
            onClose={() => setDetailPos(null)}
            mapLink={mapLink}
          />,
          document.body,
        )}
    </>
  );
}
