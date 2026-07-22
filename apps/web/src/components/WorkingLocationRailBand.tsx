import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import { formatDetailDateTime, formatRange } from "../layout/gridMetrics";
import type { WorkingLocationRailItem } from "../layout/workingLocationRail";
import { EventDetailCard, type CalendarInfo } from "./EventBlock";
import { fillTooltipContent, getSharedTooltipEl, positionTooltip } from "./eventPopoverShared";
import { PlaceIcon } from "./icons";

const HOVER_DELAY_MS = 400;
const PLACE_ICON_SIZE_PX = 12;

interface WorkingLocationRailBandProps {
  item: WorkingLocationRailItem;
  /**
   * 描画 top(px)。2026-07-22 横ずれ解消リファクタ以前はこのコンポーネントが
   * item.startMinutes から minutesToPx() で自前計算していたが、現在は呼び出し元
   * (DayColumn.tsx)が算出した値をそのまま渡す(縦位置は本来の時刻のまま ―― 列パッキングは
   * 横の列だけを分けるので押し下げは発生しない、layout/railStack.ts 参照)。
   */
  top: number;
  /** 描画高さ(px)。呼び出し元が RAIL_MIN_BAND_HEIGHT_PX(gridMetrics.ts)等の下限を適用済みの値を渡す */
  height: number;
  /**
   * 描画 left(px、レール列基準)。OOO と勤務場所は同じ x=0 起点の列を共有し、時間が
   * 重なる帯どうしだけ layout/railStack.ts の列パッキングで列を分けて横に並べる
   * (`column * RAIL_BAND_WIDTH_PX`)。重ならない帯は全て left=0 で縦に並ぶ。
   */
  left: number;
  timeZone: string;
  /** `${accountId}:${calendarId}` → カレンダー名/色。EventDetailCard の全所属列挙に使う */
  calendarLookup: Map<string, CalendarInfo>;
}

/**
 * 勤務場所(workingLocation)レールの1本(DayColumn.tsx から使う)。時刻予定専用
 * (2026-07-22 終日レーンへ統合 ―― 終日の勤務場所はこのコンポーネントに来なくなり、
 * AllDayBar.tsx 側の通常フロー(`.allday-bar--working-location`)で表示される。
 * item.subject/groupMembers も Occurrence 限定の型になっている、layout/workingLocationRail.ts 参照)。
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
  top,
  height,
  left,
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
    const rangeLabel = formatRange(subject.startMs, subject.endMs, timeZone);
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

  const dateTimeLabel = formatDetailDateTime(subject.startMs, subject.endMs, timeZone);

  return (
    <>
      <div
        className="day-workloc-band"
        style={{ top, height, left }}
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
