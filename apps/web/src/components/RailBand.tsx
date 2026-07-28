import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import type { AllDayOccurrence, Occurrence } from "../model/types";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import { useHoverTooltip } from "../hooks/useHoverTooltip";
import { formatAllDayDateRange, formatDetailDateTime, formatRange } from "../layout/gridMetrics";
import { resolveDisplayColor } from "../layout/eventColors";
import type { OooRailItem } from "../layout/oooRail";
import type { WorkingLocationRailItem } from "../layout/workingLocationRail";
import { EventDetailCard, type CalendarInfo } from "./EventBlock";
import { PlaceIcon } from "./icons";

/** 勤務場所の帯の上端に置く地図ピンの一辺(px) */
const PLACE_ICON_SIZE_PX = 12;

/** subject が時刻予定(Occurrence)かどうかの構造的ガード(DayColumn.tsx の振り分けと同じ判定) */
function isTimedSubject(subject: Occurrence | AllDayOccurrence): subject is Occurrence {
  return "startMs" in subject;
}

interface RailBandCommonProps {
  /**
   * 描画 top(px)。2026-07-22 横ずれ解消リファクタ以前はこのコンポーネントが
   * item.startMinutes から minutesToPx() で自前計算していたが、現在は呼び出し元
   * (DayColumn.tsx)が算出した値をそのまま渡す ―― 終日 OOO(全高、常に top=0)と
   * 時刻の帯(列パッキング後も縦位置は本来の時刻のまま、押し下げない)の両方を
   * 同じ props 形状で扱えるようにするため。
   */
  top: number;
  /** 描画高さ(px)。呼び出し元が RAIL_MIN_BAND_HEIGHT_PX(gridMetrics.ts)等の下限を適用済みの値を渡す */
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
 * variant と item は必ず対応する(不在レールには OooRailItem、勤務場所レールには
 * WorkingLocationRailItem しか渡せない)ことを型で保証する判別可能ユニオン。
 * どちらの subject も時刻予定 (Occurrence) と終日予定 (AllDayOccurrence) の合併型
 * (勤務場所は 2026-07-29「1日の区間として描く」で、終日ぶんが「その日の既定の場所=地」の
 * 区間としてこのレールへ戻ってきた。layout/workingLocationRail.ts 参照)。
 */
export type RailBandProps = RailBandCommonProps &
  (
    | { variant: "ooo"; item: OooRailItem }
    | { variant: "workingLocation"; item: WorkingLocationRailItem }
  );

/**
 * 日列端レールの1本(DayColumn.tsx から使う)。不在 (Out of Office) と勤務場所
 * (workingLocation) の2種類を variant で切り替える。
 *
 * 経緯(2026-07-26 リファクタ フェーズ3a): 元は RailBand.tsx と RailBand.tsx
 * の2ファイルに分かれていたが、中身は約90%が同一だった(ホバーツールチップ・クリックでの
 * 詳細ポップオーバー・useCloseOnOutsideOrEscape・EventDetailCard のポータル描画がそのまま
 * 写されていた ―― フェーズ1a で useHoverTooltip に集約した後は差分がさらに小さくなった)。
 * 片方だけ直す事故を防ぐため1ファイルへ統合し、残った差分だけを variant で分岐させている:
 *
 * - 塗り: OOO はカレンダー色(resolveDisplayColor)を inline style の backgroundColor で敷き
 *   「どのカレンダーの不在か」を主張する。勤務場所は時刻予定・終日予定を問わずほぼ毎日出うる
 *   情報なので、朱やカレンダー色は使わず brand の薄墨枡色(#DCD6C9、brand/README.md
 *   「ふつうの日の枡」)を低 opacity で敷くだけの「地の薄い帯」に留める(ユーザー方針: OOO の
 *   ような強い主張はしない)。勤務場所は occurrence ごとに変わる値が無いため、色/opacity は
 *   inline style ではなく WeekGrid.css の `.day-workloc-band` 側で管理する。
 * - 上端の飾り: OOO は白文字の × グリフ(CSS `.day-ooo-line::after` の擬似要素テキスト、
 *   どの塗り色の上でも読めるよう常に白固定)。勤務場所は「その日どこで働くか」を示す地図ピン
 *   (PlaceIcon、墨 #24211e)を帯内側の上端に置く ―― SVG は擬似要素のコンテンツにしにくいため
 *   実 DOM の子要素として配置する。帯本体は両 variant とも pointer-events: none で当たり判定を
 *   ::before(WeekGrid.css)へ委譲しており、PlaceIcon はその none を継承する(CSS 側でも明示)
 *   ため帯の当たり判定を妨げない。
 * - ツールチップの補足行: OOO は subject.location を出す。勤務場所の「場所」は title 自体が
 *   表す(例: 自宅/オフィス)ため location 行は出さない(旧点ピン版からの決定を維持)。
 *   「地図で開く」リンクも付けない ―― 勤務場所の title は住所とは限らず、Google マップ検索に
 *   投げても正しい結果にならないことがあるため。
 *
 * item.subject は時刻予定 (Occurrence) と終日予定 (AllDayOccurrence) のどちらもありうる。
 * 不在は「終日の不在を全高ラインとして時刻予定と同じ配列に合流させたもの」、勤務場所は
 * 「終日の勤務場所を地として1日ぶんの区間に畳んだもの」がそれぞれ終日側の由来
 * (どちらも合流は WeekGrid.tsx 側で済ませてある)。ラベル整形だけ isTimedSubject で分岐し、
 * 終日由来なら元の終日予定の日付範囲を出す ―― 区間は切り出した断片だが、詳細で示すべきは
 * 「その区間の根拠になっている予定そのもの」なので、断片の時刻ではなく元の範囲を見せる。
 *
 * ホバーのツールチップ・クリック/タップの詳細ポップオーバーは EventBlock/AllDayBar と全く同じ
 * 機構(hooks/useHoverTooltip.ts + eventPopoverShared.ts の共有ツールチップ DOM ノード、
 * EventDetailCard)をそのまま再利用する — 新しいポップオーバー実装は作らない(ユーザー要件)。
 * ドラッグ/リサイズは持たない(表示専用)。
 */
export function RailBand({
  variant,
  item,
  top,
  height,
  left,
  timeZone,
  calendarLookup,
}: RailBandProps) {
  const detailCardRef = useRef<HTMLDivElement>(null);
  const [detailPos, setDetailPos] = useState<{ x: number; y: number } | null>(null);

  const { subject, groupMembers } = item;
  const isOoo = variant === "ooo";

  // ホバーツールチップは AllDayBar.tsx / EventBlock.tsx と共通の hook
  // (hooks/useHoverTooltip.ts、2026-07-25)。ドラッグを持たないので suppress は渡さない
  const tooltip = useHoverTooltip(() => ({
    title: subject.title,
    rangeLabel: isTimedSubject(subject)
      ? formatRange(subject.startMs, subject.endMs, timeZone)
      : formatAllDayDateRange(subject.startDate, subject.endDate),
    // 勤務場所は location 行を出さない(上記コメント参照)
    location: isOoo ? subject.location : undefined,
  }));

  // クリック(デスクトップ)・タップ(タッチ、ブラウザが touchend から click を合成する)の
  // どちらもこの1本の onClick で受ける。EventBlock のような「移動量で click/drag を判別」する
  // 仕組みは不要(この要素自体がドラッグ不可のため)
  function handleClick(e: ReactMouseEvent<HTMLDivElement>) {
    tooltip.hide();
    setDetailPos({ x: e.clientX, y: e.clientY });
  }

  useCloseOnOutsideOrEscape(detailPos !== null, detailCardRef, () => setDetailPos(null));

  const dateTimeLabel = isTimedSubject(subject)
    ? formatDetailDateTime(subject.startMs, subject.endMs, timeZone)
    : formatAllDayDateRange(subject.startDate, subject.endDate);

  // OOO の塗りは EventBlock と同じ resolveDisplayColor で解決したカレンダー色を使う
  // (ユーザー要望 2026-07-22: 当初の「薄墨で色を殺す」案から変更 ―― どのカレンダーの不在かが
  // 一目で分かる方を優先)。上端の ×(WeekGrid.css の ::after)はどの色の上でも読めるよう常に
  // 白固定にしてあるため、ここでは color は渡さない(矩形化以前は ::after が color: inherit で
  // この値を拾っていたが、そのやり方は廃止した)。解決結果が空文字(未設定のレガシー
  // キャッシュ等)なら従来の薄墨にフォールバックする。
  // 勤務場所は backgroundColor を一切 inline で持たない(CSS 側の固定値に任せる)。
  const style: CSSProperties = isOoo
    ? {
        top,
        height,
        left,
        // フォールバックの薄墨は UI のトーンなので theme.css のトークンを参照する
        backgroundColor: resolveDisplayColor(subject, calendarLookup) || "var(--c-ink-sub)",
      }
    : { top, height, left };

  return (
    <>
      <div
        className={isOoo ? "day-ooo-line" : "day-workloc-band"}
        style={style}
        onPointerEnter={tooltip.onPointerEnter}
        onPointerMove={tooltip.onPointerMove}
        onPointerLeave={tooltip.onPointerLeave}
        onClick={handleClick}
      >
        {!isOoo && (
          <PlaceIcon
            width={PLACE_ICON_SIZE_PX}
            height={PLACE_ICON_SIZE_PX}
            className="day-workloc-band-icon"
          />
        )}
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
