import { useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import type { View } from "../keyboard/shortcuts";
import { monthGridWeeks } from "../layout/monthGrid";
import { activeMonthAnchor, isMiniMonthHighlighted } from "../layout/miniMonth";
import { WEEKDAY_LABELS } from "../layout/gridMetrics";
import "./MiniMonthCalendar.css";

export interface MiniMonthCalendarProps {
  view: View;
  timelineStart: Temporal.PlainDate;
  dayCount: number;
  monthCursor: Temporal.PlainDate;
  /** 今日判定に使う(App.tsx の timeZone をそのまま渡す、Temporal ベースの既存流儀に合わせる) */
  timeZone: string;
  /**
   * 日付クリック時に呼ばれる。view に応じて timelineStart/monthCursor のどちらを動かすかは
   * App.tsx 側(layout/miniMonth.ts の resolveMiniMonthNavigation)が決める ―― このコンポーネントは
   * クリックされた日をそのまま伝えるだけで、ナビゲーション規則そのものは持たない。
   */
  onNavigateDate: (date: Temporal.PlainDate) => void;
}

function monthKey(date: Temporal.PlainDate): string {
  return `${date.year}-${date.month}`;
}

/**
 * 左ペイン最上部のミニ月カレンダー(左ペイン増分2、2026-07-22)。Notion Calendar 等の
 * 「小さな月ピッカー」に倣い、6週×7列の固定グリッドを常設する。日付グリッド生成自体は
 * MonthView と同じ layout/monthGrid.ts の純関数(monthGridWeeks)をそのまま再利用し、
 * このコンポーネント/layout/miniMonth.ts が持つのは「どの月を表示するか」
 * 「クリックでメインへどう伝えるか」だけ。
 *
 * 表示している月はメイン(タイムライン/月表示)の現在位置に追従するが、◂▸ボタンで
 * ミニカレンダー自身を独立してブラウズできる(メインの表示自体は変えない、Google/Notion
 * Calendar と同じ体験)。メインが別の月を表示するようになったら(view 切替・週送り・
 * 今日ボタン等)、その時点で追従を再開する ―― 「表示中の月が変わったら追従し直す」の
 * 判定は React 公式の『レンダー中に state を調整する』パターンで行う(useEffect を使わず、
 * 余計なコミット/ペイントなしに同一レンダー内で収束させる。cursor が独立ブラウズ中でも
 * activeAnchor 自体は毎回計算し、その月が前回と変わっていた場合だけ cursor を上書きする)。
 */
export function MiniMonthCalendar({
  view,
  timelineStart,
  dayCount,
  monthCursor,
  timeZone,
  onNavigateDate,
}: MiniMonthCalendarProps) {
  const activeAnchor = activeMonthAnchor(view, timelineStart, monthCursor);
  const activeAnchorKey = monthKey(activeAnchor);

  const [cursor, setCursor] = useState(activeAnchor);
  const [syncedAnchorKey, setSyncedAnchorKey] = useState(activeAnchorKey);
  if (activeAnchorKey !== syncedAnchorKey) {
    setSyncedAnchorKey(activeAnchorKey);
    setCursor(activeAnchor);
  }

  const todayDate = Temporal.Now.plainDateISO(timeZone);
  const weeks = monthGridWeeks(cursor);

  return (
    <div className="mini-month">
      <div className="mini-month-header">
        <button
          type="button"
          className="mini-month-nav-btn"
          onClick={() => setCursor((c) => c.subtract({ months: 1 }))}
          aria-label="ミニカレンダーの前月"
        >
          ◂
        </button>
        <span className="mini-month-title">
          {cursor.year}年{cursor.month}月
        </span>
        <button
          type="button"
          className="mini-month-nav-btn"
          onClick={() => setCursor((c) => c.add({ months: 1 }))}
          aria-label="ミニカレンダーの翌月"
        >
          ▸
        </button>
      </div>
      <div className="mini-month-weekday-header">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label} className="mini-month-weekday">
            {label}
          </span>
        ))}
      </div>
      <div className="mini-month-grid">
        {weeks.map((week, weekIndex) => (
          // eslint-disable-next-line react/no-array-index-key -- 週の並びは固定(monthGridWeeks が決定的に生成)
          <div className="mini-month-week" key={weekIndex}>
            {week.map((day) => {
              const isToday = day.date.equals(todayDate);
              const isActive = isMiniMonthHighlighted(
                day.date,
                view,
                timelineStart,
                dayCount,
                monthCursor,
              );
              return (
                <button
                  type="button"
                  key={day.date.toString()}
                  className={
                    "mini-month-day" +
                    (day.inMonth ? "" : " mini-month-day--outside") +
                    (isActive ? " mini-month-day--active" : "")
                  }
                  aria-label={`${day.date.month}月${day.date.day}日へ移動`}
                  onClick={() => onNavigateDate(day.date)}
                >
                  <span className={isToday ? "mini-month-day-num is-today" : "mini-month-day-num"}>
                    {day.date.day}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
