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
import { resolveDisplayColor } from "../layout/eventColors";
import type { OooRailItem } from "../layout/oooRail";
import { EventDetailCard, type CalendarInfo } from "./EventBlock";
import { fillTooltipContent, getSharedTooltipEl, positionTooltip } from "./eventPopoverShared";

const HOVER_DELAY_MS = 400;

/** OooRailItem.subject が時刻予定(Occurrence)かどうかの構造的ガード */
function isTimedSubject(subject: Occurrence | AllDayOccurrence): subject is Occurrence {
  return "startMs" in subject;
}

interface OooRailLineProps {
  item: OooRailItem;
  timeZone: string;
  /** `${accountId}:${calendarId}` → カレンダー名/色。EventDetailCard の全所属列挙に使う */
  calendarLookup: Map<string, CalendarInfo>;
}

/**
 * 不在 (Out of Office) レールの1本(DayColumn.tsx から使う、2026-07-22)。
 *
 * 通常の予定カード (EventBlock) の代わりに、日列端の細いレール(.day-ooo-rail、
 * DayColumn.tsx 側で左端 .day-ci-rail と同じガターに置く)上へ時間範囲ぶんの縦ラインを
 * 描き、CSS 側 (.day-ooo-line::after) が上端に × を出す。色はカレンダー色を使わず
 * 薄墨で統一する(不在は「場が空いていないこと」の記号なので色を殺す、ユーザー決定)。
 *
 * ホバーのツールチップ・クリック/タップの詳細ポップオーバーは EventBlock/AllDayBar と
 * 全く同じ機構(eventPopoverShared.ts の共有ツールチップ DOM ノード、EventDetailCard)を
 * そのまま再利用する — 新しいポップオーバー実装は作らない(ユーザー要件)。ドラッグ/
 * リサイズは持たない(表示専用)ため、フォーム自体は AllDayBar.tsx に一番近い。
 *
 * item.subject は時刻予定 (Occurrence) と終日予定 (AllDayOccurrence) のどちらもありうる
 * (終日の不在は WeekGrid.tsx 側で「その日の全高ライン」として時刻予定と同じ配列に
 * 合流させてから渡ってくる)。ラベル整形だけ isTimedSubject で分岐する。
 */
export function OooRailLine({ item, timeZone, calendarLookup }: OooRailLineProps) {
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
    const rangeLabel = isTimedSubject(subject)
      ? formatRange(subject.startMs, subject.endMs, timeZone)
      : formatAllDayDateRange(subject.startDate, subject.endDate);
    fillTooltipContent(el, subject.title, rangeLabel, subject.location);
    el.style.display = "block";
    positionTooltip(el, clientX, clientY);
    tooltipShownRef.current = true;
  }

  // pointerenter/leave/move によるホバーツールチップは AllDayBar.tsx と同一の実装
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
  // どちらもこの1本の onClick で受ける。EventBlock のような「移動量で click/drag を判別」する
  // 仕組みは不要(この要素自体がドラッグ不可のため)
  function handleClick(e: ReactMouseEvent<HTMLDivElement>) {
    hideTooltip();
    setDetailPos({ x: e.clientX, y: e.clientY });
  }

  useCloseOnOutsideOrEscape(detailPos !== null, detailCardRef, () => setDetailPos(null));

  const dateTimeLabel = isTimedSubject(subject)
    ? formatDetailDateTime(subject.startMs, subject.endMs, timeZone)
    : formatAllDayDateRange(subject.startDate, subject.endDate);

  // カレンダー色を EventBlock と同じ resolveDisplayColor で解決し、ライン(backgroundColor)と
  // 上端の ×(::after が color: inherit で拾う)を同色にする(ユーザー要望 2026-07-22:
  // 当初の「薄墨で色を殺す」案から変更 — どのカレンダーの不在かが一目で分かる方を優先)。
  // 解決結果が空文字(未設定のレガシーキャッシュ等)なら従来の薄墨にフォールバック
  const displayColor = resolveDisplayColor(subject, calendarLookup) || "#8a8478";

  return (
    <>
      <div
        className="day-ooo-line"
        style={{
          top: minutesToPx(item.startMinutes),
          height: Math.max(minutesToPx(item.endMinutes - item.startMinutes), 2),
          backgroundColor: displayColor,
          color: displayColor,
        }}
        onPointerEnter={handlePointerEnter}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onClick={handleClick}
      />
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
