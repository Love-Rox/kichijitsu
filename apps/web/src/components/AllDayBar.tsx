import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import type { RsvpResponseStatus } from "@kichijitsu/shared";
import type { AllDayOccurrence } from "../model/types";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import { useHoverTooltip } from "../hooks/useHoverTooltip";
import { formatAllDayDateRange } from "../layout/gridMetrics";
import { isOutOfOffice } from "../layout/oooRail";
import { isWorkingLocation } from "../layout/workingLocationRail";
import { meetingLocationLabel } from "../layout/meetingLinks";
import { EventDetailCard, type CalendarInfo } from "./EventBlock";
import { resolveDisplayColor } from "../layout/eventColors";
import { PlaceIcon } from "./icons";
import {
  draftFromAllDayOccurrence,
  isEditableEventSubject,
  type EventEditDraft,
} from "../sync/eventEdit";
import "./AllDayBar.css";

/** 終日レーンの勤務場所バー先頭に置く地図ピンの大きさ(px)。時刻予定側の帯上端ピンと揃える */
const WORKING_LOCATION_ICON_SIZE_PX = 11;

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
  const detailCardRef = useRef<HTMLDivElement>(null);
  const [detailPos, setDetailPos] = useState<{ x: number; y: number } | null>(null);

  // 勤務場所(workingLocation、2026-07-22 終日レーンへ統合): WeekGrid 側が終日の勤務場所を
  // barGroups に残すため、このコンポーネントにも occurrence.isWorkingLocation===true な
  // occurrence が渡ってくる。ツールチップ/style/JSX の各所で isWorkingLoc を見て見た目だけ
  // 分岐させる(判定関数 isWorkingLocation は時刻予定側の layout/workingLocationRail.ts と共通)。
  //
  // 2026-07-29「1日の区間として描く」: ここへ届くのは **その日に時刻付きの勤務場所が1件も
  // 無い場合だけ** になった(splitWorkingLocationAllDayGroups が振り分ける)。時刻付きがある日は
  // 終日ぶんも「その日の既定の場所」としてタイムライン側の区間に畳まれる ―― 従来はチップと帯が
  // 独立に並び「勤務地の変更前と変更後の両方が残っている」ように見えていた。このコンポーネント
  // 自体の分岐は一切変えていない(時刻付きが無い日の見え方は据え置き)。
  const isWorkingLoc = isWorkingLocation(occurrence);

  // 不在 (OOO、2026-07-28 「終日欄に出す」設定): 左ペイン「表示」で
  // oooAllDayPlacement="allday" が選ばれている間だけ、終日の不在がこのコンポーネントに
  // 届く(既定の "timeline" では WeekGrid が splitOutOfOfficeAllDayGroups で抜いてしまうので
  // 常に false)。勤務場所を終日レーンへ統合したときと同じ形 ―― 振り分けは純関数側、
  // 見た目の分岐はここで occurrence.isOutOfOffice を直接見る(判定関数は layout/oooRail.ts)。
  //
  // 2026-07-29「1日を丸ごと覆う不在」: ここへ届く不在には、元が時刻付き (`dateTime`) で
  // 1日を丸ごと覆っていたものを終日予定の形へ射影したぶんも混ざる
  // (layout/oooDayCoverage.ts の dayCoveringOooAllDayGroups)。射影の時点で startDate/endDate
  // だけを持つ普通の AllDayOccurrence になっているため、**このコンポーネントは元が時刻付き
  // だったかを知らないし、知る必要も無い**(それが合併型ではなく射影を選んだ理由)。
  // 下の editDraft/rsvp を不在では出さない判断のおかげで、射影で捨てた時刻が Google へ
  // 書き戻される経路も存在しない。
  const isOoo = isOutOfOffice(occurrence);

  // ホバーツールチップ(hooks/useHoverTooltip.ts に共通化、2026-07-25)。
  // 勤務場所は RailBand.tsx と同じ決定で location 補足行を出さない
  // (title 自体が場所を表す。例: 自宅/オフィス。location フィールドは通常使わない)。
  const tooltip = useHoverTooltip(() => ({
    title: occurrence.title,
    rangeLabel: formatAllDayDateRange(occurrence.startDate, occurrence.endDate),
    // 会議 URL (Slack ハドル等) はラベルに置き換える(2026-07-25、layout/meetingLinks.ts)。
    // 終日バー自体は location を表に出さないが、ツールチップだけは出しているため
    // ここも生 URL ではなく「Slack ハドル」のような短い表示にする
    location: isWorkingLoc ? undefined : meetingLocationLabel(occurrence.location),
  }));

  function handleClick(e: ReactMouseEvent<HTMLDivElement>) {
    tooltip.hide();
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
  // (要件: declined の line-through+淡色、needsAction の輪郭表現のみ)。勤務場所・不在は通常
  // attendees を持たないので同時に立つことは実質無いが、MonthView と同じくそちらの見た目を
  // 優先し(下記 style)、declined/needsAction の色上書きとは排他にしてある。
  const rsvpStatus = isWorkingLoc || isOoo ? undefined : occurrence.responseStatus;
  const isDeclined = rsvpStatus === "declined";
  const isNeedsAction = rsvpStatus === "needsAction";
  const style: CSSProperties = {
    gridRow: row,
    gridColumn: `${colStart} / ${colEnd}`,
    // 勤務場所(2026-07-22 終日レーンへ統合): カレンダー色を一切使わず、WeekGrid.css の
    // .allday-bar--working-location 側で薄墨枡色(#DCD6C9)の固定背景・ボーダー無しを
    // 敷く(時刻予定側の .day-workloc-band と同じ色)。inline style は座標系だけに留める。
    ...(isWorkingLoc
      ? {}
      : isOoo
        ? {
            // 不在 (2026-07-28): タイムラインの全高ライン (.day-ooo-line) と地続きに見せるため、
            // 他の終日バーのような薄い混色ではなくカレンダー色でベタ塗りする ―― 白い × が
            // どの色の上でも読める、という点まで含めてレール側と同じ作りに揃えてある。
            backgroundColor: displayColor,
            borderLeftColor: displayColor,
          }
        : isNeedsAction
          ? ({ "--rsvp-color": displayColor } as CSSProperties)
          : {
              // 混合比はトークン (theme.css の --c-event-tint-allday、ダークで上がる)
              backgroundColor: `color-mix(in srgb, ${displayColor} var(--c-event-tint-allday), var(--c-surface))`,
              borderLeftColor: displayColor,
            }),
  };

  return (
    <>
      <div
        className={[
          "allday-bar",
          isWorkingLoc ? "allday-bar--working-location" : "",
          isOoo ? "allday-bar--ooo" : "",
          isDeclined ? "allday-bar--declined" : "",
          isNeedsAction ? "allday-bar--needs-action" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={style}
        onPointerEnter={tooltip.onPointerEnter}
        onPointerMove={tooltip.onPointerMove}
        onPointerLeave={tooltip.onPointerLeave}
        onClick={handleClick}
      >
        {isWorkingLoc && (
          // 先頭の地図ピン(墨色、WeekGrid.css の .allday-bar-working-location-icon が
          // 色を指定する)。時刻予定側の帯上端ピン(RailBand.tsx)と同じ
          // 「勤務場所である」ことを示す視覚的な印。
          <PlaceIcon
            width={WORKING_LOCATION_ICON_SIZE_PX}
            height={WORKING_LOCATION_ICON_SIZE_PX}
            className="allday-bar-working-location-icon"
          />
        )}
        {isOoo && (
          // 不在の印 (2026-07-28)。レール側 (.day-ooo-line::after) と同じ白い × グリフを、
          // 横並びのバーではタイトルの前に置く(ランディング/ドキュメントの説明
          // 「不在はカレンダー色 + 白い×」と地続きの意匠)。月表示チップの `× タイトル` とも揃う。
          <span className="allday-bar-ooo-mark" aria-hidden="true">
            ×
          </span>
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
              // 不在 (2026-07-28): 詳細カードは表示のみにする ―― タイムライン側の不在
              // (RailBand.tsx) が editDraft/rsvp を一切渡さないのと揃える。同じ予定が
              // 置き場所の設定次第で編集できたりできなかったりする方が不自然なため
              // (ドキュメント docs/calendar「不在」の節の説明とも一致させる)。
              !isOoo && isEditableEventSubject(occurrence)
                ? draftFromAllDayOccurrence(occurrence, timeZone)
                : undefined
            }
            canToggleAllDay={occurrence.seriesId === null}
            onSaveEdit={(draft) => onSaveEdit(occurrence, draft)}
            // 不在は出欠ボタンも出さない(上の editDraft と同じ理由)。勤務場所は従来どおり
            // occurrence.responseStatus をそのまま渡す ―― 見た目の分岐(バー本体の色)と違い、
            // 詳細カード側の挙動はここで変えない
            rsvpStatus={isOoo ? undefined : occurrence.responseStatus}
            onRsvp={(status) => onRsvp(occurrence, status)}
          />,
          document.body,
        )}
    </>
  );
}
