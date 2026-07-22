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
const PLACE_ICON_SIZE_PX = 12;
/**
 * OOO 帯 (OooRailLine.tsx) の MIN_BAR_HEIGHT_PX と同じ理由: 短時間の勤務場所(数分)でも
 * 上端の PlaceIcon(top: 2px + 12px)が帯の外にはみ出さないだけの最低高さを確保する。
 */
const MIN_BAND_HEIGHT_PX = 16;

/** WorkingLocationRailItem.subject が時刻予定(Occurrence)かどうかの構造的ガード(OooRailLine.tsx と同じ) */
function isTimedSubject(subject: Occurrence | AllDayOccurrence): subject is Occurrence {
  return "startMs" in subject;
}

interface WorkingLocationRailBandProps {
  item: WorkingLocationRailItem;
  timeZone: string;
  /** `${accountId}:${calendarId}` → カレンダー名/色。EventDetailCard の全所属列挙に使う */
  calendarLookup: Map<string, CalendarInfo>;
}

/**
 * 勤務場所(workingLocation)レールの1本(DayColumn.tsx から使う、2026-07-22 帯化)。
 *
 * 経緯: 直前(点ピン版、旧 WorkingLocationRailPin.tsx)は「勤務場所は一点の情報」という
 * 判断で開始時刻ちょうどの位置に PlaceIcon を1個置くだけだった。しかしユーザーから
 * 「勤務場所は OOO (不在) のように帯(バー)で表示したい」という明確な要望があり、
 * OooRailLine.tsx を土台に帯として作り替えた。item は topMinutes(点)ではなく
 * startMinutes/endMinutes(範囲、layout/workingLocationRail.ts 参照)を持つようになった
 * ので、OOO と全く同じ「top + height」の矩形として描画する。
 *
 * OOO 帯との違いは配色と上端の飾りだけ(形は完全に同じ):
 * - 塗り: OOO はカレンダー色(resolveDisplayColor)で「どのカレンダーの不在か」を主張するが、
 *   勤務場所は時刻予定・終日予定を問わずほぼ毎日出うる情報なので、朱やカレンダー色は使わず
 *   brand の薄墨枡色(#DCD6C9、brand/README.md「ふつうの日の枡」)を低 opacity で敷くだけの
 *   「地の薄い帯」に留める(ユーザー方針: OOO のような強い主張はしない)。実際の色/opacity
 *   の値は WeekGrid.css の .day-workloc-band 側で管理する(OOO と違い occurrence ごとに
 *   変わる値ではないため、ここでは inline style にせず CSS 固定値にしてある)。
 * - 上端の飾り: OOO は白文字の × グリフ(CSS ::after の擬似要素テキスト)だが、勤務場所は
 *   「その日どこで働くか」を示す地図ピン(PlaceIcon、墨 #24211e)を帯内側の上端に置く。
 *   SVG は CSS 疑似要素のコンテンツにしにくいため、擬似要素ではなく実 DOM の子要素として
 *   配置する。帯本体は OOO と同じく pointer-events: none にして当たり判定を ::before
 *   (WeekGrid.css)へ委譲しており、PlaceIcon はその pointer-events: none を継承する
 *   (明示的にも CSS 側で none を指定)ため、帯の当たり判定を一切妨げない。
 *
 * ホバーのツールチップ・クリック/タップの詳細ポップオーバーは OooRailLine.tsx と同じ
 * 共有機構(eventPopoverShared.ts の共有ツールチップ DOM ノード、EventDetailCard)を
 * そのまま再利用する。「地図で開く」リンクは付けない(旧点ピン版からの決定を維持 ――
 * 勤務場所の title (例: 自宅/オフィス) は住所とは限らないため、Google マップ検索に投げても
 * 正しい結果にならないことがある)。ドラッグ/リサイズは持たない表示専用。
 */
export function WorkingLocationRailBand({
  item,
  timeZone,
  calendarLookup,
}: WorkingLocationRailBandProps) {
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
    // フィールドは勤務場所では通常使わないため、ツールチップの補足行には出さない
    // (旧点ピン版からの決定を維持)。
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

  // クリック(デスクトップ)・タップ(タッチ、ブラウザが touchend から click を合成する)の
  // どちらもこの1本の onClick で受ける(OooRailLine.tsx と同じ流儀。この要素自体が
  // ドラッグ不可のため click/drag 判別は不要)
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
        className="day-workloc-band"
        style={{
          top: minutesToPx(item.startMinutes),
          height: Math.max(minutesToPx(item.endMinutes - item.startMinutes), MIN_BAND_HEIGHT_PX),
        }}
        onPointerEnter={handlePointerEnter}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onClick={handleClick}
      >
        <PlaceIcon
          width={PLACE_ICON_SIZE_PX}
          height={PLACE_ICON_SIZE_PX}
          className="day-workloc-band-icon"
        />
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
