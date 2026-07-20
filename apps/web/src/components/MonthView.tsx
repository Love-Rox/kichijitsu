import { useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { Temporal } from "@js-temporal/polyfill";
import type { Occurrence } from "../model/types";
import type { OccurrenceStore } from "../store/occurrenceStore";
import { useOccurrences } from "../store/occurrenceStore";
import type { AllDayStore } from "../store/allDayStore";
import { useAllDayOccurrences } from "../store/allDayStore";
import type { WriteTargetCandidate } from "../sync/eventCreate";
import {
  groupDuplicateAllDayOccurrences,
  groupDuplicateOccurrences,
} from "../layout/groupDuplicates";
import {
  bucketMonthChips,
  monthGridDays,
  monthGridRangeMs,
  type MonthCellChips,
  type MonthChip,
} from "../layout/monthGrid";
import {
  formatAllDayDateRange,
  formatDetailDateTime,
  formatTime,
  WEEKDAY_LABELS,
} from "../layout/gridMetrics";
import { resolveDisplayColor } from "../layout/eventColors";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import { EventDetailCard, type CalendarInfo } from "./EventBlock";
import "./MonthView.css";

interface MonthViewProps {
  store: OccurrenceStore;
  allDayStore: AllDayStore;
  /** 表示する月内の任意の日(App.tsx は常に1日を渡す) */
  monthCursor: Temporal.PlainDate;
  timeZone: string;
  visibleCalendarKeys: Set<string>;
  calendarLookup: Map<string, CalendarInfo>;
  onDelete: (occurrence: Occurrence) => void;
  /**
   * WeekGrid と揃えた共通 props(App.tsx から同じ形で渡ってくる)。月ビュー v1 では
   * ドラッグ移動・空き領域からの新規作成は対象外(week ビューでのみ行う設計、上位の
   * 設計ドキュメント フェーズ6 参照)なので、このコンポーネントは意図的に使わない。
   * 将来 month ビューでの作成/移動に対応するときのために props 形状だけ揃えてある。
   */
  writeTarget: WriteTargetCandidate | null;
  onCreateEvent: (
    startMs: number,
    endMs: number,
    title: string,
    target: WriteTargetCandidate,
  ) => void;
  /** チップ以外のセル空き部分・「+N」クリックで呼ばれる: その日を含む週の week ビューへ切り替える */
  onNavigateToDay: (day: Temporal.PlainDate) => void;
}

/** セル描画に必要な情報一式(bucketMonthChips の結果 + 当月内かどうか) */
interface MonthCellData extends MonthCellChips {
  inMonth: boolean;
}

interface DetailState {
  chip: MonthChip;
  position: { x: number; y: number };
}

function isTimedChip(chip: MonthChip): chip is MonthChip & { kind: "timed"; startMs: number } {
  return chip.kind === "timed";
}

/**
 * 月表示ビュー(フェーズ6)。6週×7列の固定グリッドで、各セルに終日予定→時刻予定の
 * 順でチップを並べる。仮想化はしない(42セル×数チップ程度で十分軽い)。
 *
 * WeekGrid と違いドラッグ移動・空き領域からの新規作成は持たない(表示 + 詳細ポップオーバー
 * + 「その日の week ビューへ」導線のみ)。作成・移動は week ビューに一本化する設計。
 *
 * TODO(docs/google-tasks.md): Google タスクは v1 では WeekGrid の日付レーンにのみ表示する
 * (月表示セルへの小さなタスク行の表示は未対応)。
 */
export function MonthView({
  store,
  allDayStore,
  monthCursor,
  timeZone,
  visibleCalendarKeys,
  calendarLookup,
  onDelete,
  onNavigateToDay,
}: MonthViewProps) {
  const detailCardRef = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);

  const todayDate = useMemo(() => Temporal.Now.plainDateISO(), []);

  const days = useMemo(() => monthGridDays(monthCursor), [monthCursor]);

  const { fromMs, toMs } = useMemo(
    () => monthGridRangeMs(monthCursor, timeZone),
    [monthCursor, timeZone],
  );
  const occurrences = useOccurrences(store, fromMs, toMs);
  const visibleOccurrences = useMemo(
    () =>
      occurrences.filter(
        (o) => o.source !== "google" || visibleCalendarKeys.has(`${o.accountId}:${o.calendarId}`),
      ),
    [occurrences, visibleCalendarKeys],
  );
  const groupedOccurrences = useMemo(
    () => groupDuplicateOccurrences(visibleOccurrences),
    [visibleOccurrences],
  );

  const allDayFromDate = useMemo(() => days[0].date.toString(), [days]);
  const allDayToDate = useMemo(() => days[days.length - 1].date.toString(), [days]);
  const allDayOccurrencesRaw = useAllDayOccurrences(allDayStore, allDayFromDate, allDayToDate);
  const visibleAllDayOccurrences = useMemo(
    () =>
      allDayOccurrencesRaw.filter(
        (o) => o.source !== "google" || visibleCalendarKeys.has(`${o.accountId}:${o.calendarId}`),
      ),
    [allDayOccurrencesRaw, visibleCalendarKeys],
  );
  const groupedAllDayOccurrences = useMemo(
    () => groupDuplicateAllDayOccurrences(visibleAllDayOccurrences),
    [visibleAllDayOccurrences],
  );

  // days と bucketMonthChips の結果は同じ順序(行優先42セル)を保つため、
  // index を揃えて inMonth をチップデータへ合流させる(検索なしの O(n) zip)
  const cells = useMemo<MonthCellData[]>(() => {
    const chipCells = bucketMonthChips(
      days,
      groupedOccurrences,
      groupedAllDayOccurrences,
      timeZone,
    );
    return chipCells.map((cell, i) => ({ ...cell, inMonth: days[i].inMonth }));
  }, [days, groupedOccurrences, groupedAllDayOccurrences, timeZone]);

  const weeks = useMemo(() => {
    const rows: MonthCellData[][] = [];
    for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
    return rows;
  }, [cells]);

  useCloseOnOutsideOrEscape(detail !== null, detailCardRef, () => setDetail(null));

  function openDetail(chip: MonthChip, e: ReactMouseEvent) {
    e.stopPropagation();
    setDetail({ chip, position: { x: e.clientX, y: e.clientY } });
  }

  const detailSubject = detail?.chip.group.primary;
  let detailDateTimeLabel = "";
  if (detail && detailSubject) {
    detailDateTimeLabel = isTimedChip(detail.chip)
      ? formatDetailDateTime(
          (detailSubject as Occurrence).startMs,
          (detailSubject as Occurrence).endMs,
          timeZone,
        )
      : formatAllDayDateRange(
          (detailSubject as { startDate: string }).startDate,
          (detailSubject as { endDate: string }).endDate,
        );
  }

  return (
    <div className="month-view">
      <div className="month-view-weekday-header">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="month-view-weekday">
            {label}
          </div>
        ))}
      </div>
      <div className="month-view-grid">
        {weeks.map((week, weekIndex) => (
          // eslint-disable-next-line react/no-array-index-key -- 週の並びは固定(monthGridWeeks が決定的に生成)
          <div className="month-view-week" key={weekIndex}>
            {week.map((cell) => {
              const isToday = cell.date.equals(todayDate);
              return (
                <div
                  key={cell.date.toString()}
                  className={
                    "month-cell" +
                    (cell.inMonth ? "" : " month-cell--outside") +
                    (isToday ? " month-cell--today" : "")
                  }
                  onClick={() => onNavigateToDay(cell.date)}
                >
                  <div className="month-cell-header">
                    <span className={isToday ? "month-cell-date is-today" : "month-cell-date"}>
                      {cell.date.day}
                    </span>
                  </div>
                  <div className="month-cell-chips">
                    {cell.visible.map((chip) => {
                      const color = resolveDisplayColor(chip.group.primary, calendarLookup);
                      return (
                        <button
                          key={chip.key}
                          type="button"
                          className={`month-chip month-chip--${chip.kind}`}
                          style={{
                            backgroundColor: `color-mix(in srgb, ${color} 16%, white)`,
                            borderLeftColor: color,
                          }}
                          onClick={(e) => openDetail(chip, e)}
                          title={chip.title}
                        >
                          {isTimedChip(chip) && (
                            <span className="month-chip-time">
                              {formatTime(chip.startMs, timeZone)}
                            </span>
                          )}
                          <span className="month-chip-title">{chip.title}</span>
                        </button>
                      );
                    })}
                    {cell.overflowCount > 0 && (
                      <button
                        type="button"
                        className="month-chip-overflow"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNavigateToDay(cell.date);
                        }}
                      >
                        +{cell.overflowCount}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {detail &&
        detailSubject &&
        createPortal(
          <EventDetailCard
            ref={detailCardRef}
            subject={detailSubject}
            dateTimeLabel={detailDateTimeLabel}
            position={detail.position}
            groupMembers={detail.chip.group.members}
            calendarLookup={calendarLookup}
            onClose={() => setDetail(null)}
            onDelete={
              isTimedChip(detail.chip) && (detailSubject as Occurrence).source === "google"
                ? () => onDelete(detailSubject as Occurrence)
                : undefined
            }
          />,
          document.body,
        )}
    </div>
  );
}
