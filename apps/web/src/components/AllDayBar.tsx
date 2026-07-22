import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { RsvpResponseStatus } from "@kichijitsu/shared";
import type { AllDayOccurrence } from "../model/types";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import { formatAllDayDateRange } from "../layout/gridMetrics";
import { isWorkingLocation } from "../layout/workingLocationRail";
import { EventDetailCard, type CalendarInfo } from "./EventBlock";
import { fillTooltipContent, getSharedTooltipEl, positionTooltip } from "./eventPopoverShared";
import { resolveDisplayColor } from "../layout/eventColors";
import { PlaceIcon } from "./icons";
import {
  draftFromAllDayOccurrence,
  isEditableEventSubject,
  type EventEditDraft,
} from "../sync/eventEdit";

/** 終日レーンの勤務場所バー先頭に置く地図ピンの大きさ(px)。時刻予定側の帯上端ピンと揃える */
const WORKING_LOCATION_ICON_SIZE_PX = 11;

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
  /** IANA タイムゾーン。編集フォームの日時入力の変換に使う(フェーズ2、2026-07-22) */
  timeZone: string;
  /** 詳細ポップオーバーの編集フォーム「保存」から呼ばれる。EventBlock.onSaveEdit と同じ流儀 */
  onSaveEdit: (occurrence: AllDayOccurrence, draft: EventEditDraft) => Promise<void>;
  /** 詳細ポップオーバーの RSVP ボタンから呼ばれる。EventBlock.onRsvp と同じ流儀 */
  onRsvp: (occurrence: AllDayOccurrence, status: RsvpResponseStatus) => Promise<void>;
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
  timeZone,
  onSaveEdit,
  onRsvp,
}: AllDayBarProps) {
  const hoverTimeoutRef = useRef<number | undefined>(undefined);
  const tooltipShownRef = useRef(false);
  const detailCardRef = useRef<HTMLDivElement>(null);
  const [detailPos, setDetailPos] = useState<{ x: number; y: number } | null>(null);

  // 勤務場所(workingLocation、2026-07-22 終日レーンへ統合): WeekGrid 側はもう終日の
  // 勤務場所を barGroups から分離しない(layout/workingLocationRail.ts 参照)ため、この
  // コンポーネントにも occurrence.isWorkingLocation===true な occurrence が普通に渡ってくる。
  // showTooltip/style/JSX の各所で isWorkingLoc を見て見た目だけ分岐させる(判定関数
  // isWorkingLocation は時刻予定側の layout/workingLocationRail.ts と共通)。
  const isWorkingLoc = isWorkingLocation(occurrence);

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
    // 勤務場所は WorkingLocationRailBand.tsx と同じ決定で location 補足行を出さない
    // (title 自体が場所を表す。例: 自宅/オフィス。location フィールドは通常使わない)。
    fillTooltipContent(
      el,
      occurrence.title,
      formatAllDayDateRange(occurrence.startDate, occurrence.endDate),
      isWorkingLoc ? undefined : occurrence.location,
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
  // resolveDisplayColor で解決する(hasCustomColor が無ければ calendarLookup のカレンダー色を優先)。
  // 勤務場所(isWorkingLoc)はこの色を使わない(下記 style 参照)ので計算しても無駄になるが、
  // event-group-dots(集約時の所属カレンダー色内訳)は勤務場所でも出しうるため常に計算しておく。
  const displayColor = resolveDisplayColor(occurrence, calendarLookup);
  // 参加ステータス表示 (RSVP、2026-07-22)。EventBlock/MonthView と対になる最小限の表現
  // (要件: declined の line-through+淡色、needsAction の輪郭表現のみ)。ここに渡る occurrence は
  // WeekGrid 側で不在(OOO)分を既に分離済み(splitOutOfOfficeAllDayGroups)なので、isOutOfOffice
  // との排他判定は不要(EventBlock/MonthView と違い isOoo チェックを持たない)。勤務場所は通常
  // RSVP を持たないため isWorkingLoc と同時に立つことは実質無いが、念のため isWorkingLoc を
  // 優先し(下記 style)、declined/needsAction の色上書きとは排他にしてある。
  const isDeclined = occurrence.responseStatus === "declined";
  const isNeedsAction = occurrence.responseStatus === "needsAction";
  const style: CSSProperties = {
    gridRow: row,
    gridColumn: `${colStart} / ${colEnd}`,
    // 勤務場所(2026-07-22 終日レーンへ統合): カレンダー色を一切使わず、WeekGrid.css の
    // .allday-bar--working-location 側で薄墨枡色(#DCD6C9)の固定背景・ボーダー無しを
    // 敷く(時刻予定側の .day-workloc-band と同じ色)。inline style は座標系だけに留める。
    ...(isWorkingLoc
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
          isWorkingLoc ? "allday-bar--working-location" : "",
          isDeclined ? "allday-bar--declined" : "",
          isNeedsAction ? "allday-bar--needs-action" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={style}
        onPointerEnter={handlePointerEnter}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onClick={handleClick}
      >
        {isWorkingLoc && (
          // 先頭の地図ピン(墨色、WeekGrid.css の .allday-bar-working-location-icon が
          // 色を指定する)。時刻予定側の帯上端ピン(WorkingLocationRailBand.tsx)と同じ
          // 「勤務場所である」ことを示す視覚的な印。
          <PlaceIcon
            width={WORKING_LOCATION_ICON_SIZE_PX}
            height={WORKING_LOCATION_ICON_SIZE_PX}
            className="allday-bar-working-location-icon"
          />
        )}
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
            timeZone={timeZone}
            editDraft={
              isEditableEventSubject(occurrence)
                ? draftFromAllDayOccurrence(occurrence, timeZone)
                : undefined
            }
            canToggleAllDay={occurrence.seriesId === null}
            onSaveEdit={(draft) => onSaveEdit(occurrence, draft)}
            rsvpStatus={occurrence.responseStatus}
            onRsvp={(status) => onRsvp(occurrence, status)}
          />,
          document.body,
        )}
    </>
  );
}
