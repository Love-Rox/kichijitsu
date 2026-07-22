import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { AllDayOccurrence, Occurrence } from "../model/types";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import { formatAllDayDateRange, formatDetailDateTime, formatRange } from "../layout/gridMetrics";
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
  /**
   * 描画 top(px)。2026-07-22 横ずれ解消リファクタ以前はこのコンポーネントが
   * item.startMinutes から minutesToPx() で自前計算していたが、現在は呼び出し元
   * (DayColumn.tsx)が算出した値をそのまま渡す ―― 終日 OOO(全高、常に top=0)と
   * 時刻 OOO(列パッキング後も縦位置は本来の時刻のまま、押し下げない)の両方を
   * 同じ props 形状で扱えるようにするため。
   */
  top: number;
  /** 描画高さ(px)。呼び出し元が RAIL_MIN_BAND_HEIGHT_PX 等の下限を適用済みの値を渡す */
  height: number;
  /**
   * 描画 left(px、レール列基準)。OOO と勤務場所は同じ x=0 起点の列を共有し、時間が
   * 重なる帯だけ layout/railStack.ts の列パッキングで列を分けて横に並べる
   * (`column * RAIL_BAND_WIDTH_PX`)。重ならない帯は全て left=0 で縦に並ぶ。
   */
  left: number;
  timeZone: string;
  /** `${accountId}:${calendarId}` → カレンダー名/色。EventDetailCard の全所属列挙に使う */
  calendarLookup: Map<string, CalendarInfo>;
}

/**
 * 不在 (Out of Office) レールの1本(DayColumn.tsx から使う、2026-07-22)。
 *
 * 通常の予定カード (EventBlock) の代わりに、日列端のレール(.day-rail、DayColumn.tsx
 * 側で左端 .day-ci-rail と同じガターに置く)上へ時間範囲ぶんの角丸矩形バー(幅 12px、
 * RAIL_BAND_WIDTH_PX)を描く。塗りは resolveDisplayColor で解決したカレンダー色(下記)、
 * 上端には CSS 側 (.day-ooo-line::after) が白文字の × を矩形内に収めて出す(矩形化、
 * 2026-07-22 ユーザー要望)。
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
export function OooRailLine({
  item,
  top,
  height,
  left,
  timeZone,
  calendarLookup,
}: OooRailLineProps) {
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

  // カレンダー色を EventBlock と同じ resolveDisplayColor で解決し、矩形バーの塗り
  // (backgroundColor)に使う(ユーザー要望 2026-07-22: 当初の「薄墨で色を殺す」案から変更 —
  // どのカレンダーの不在かが一目で分かる方を優先)。上端の ×(WeekGrid.css の ::after)は
  // どの色の上でも読めるよう常に白固定にしてあるため、ここでは color は渡さない
  // (矩形化以前は ::after が color: inherit でこの値を拾っていたが、そのやり方は廃止した)。
  // 解決結果が空文字(未設定のレガシーキャッシュ等)なら従来の薄墨にフォールバック
  const displayColor = resolveDisplayColor(subject, calendarLookup) || "#8a8478";

  return (
    <>
      <div
        className="day-ooo-line"
        style={{
          top,
          height,
          left,
          backgroundColor: displayColor,
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
