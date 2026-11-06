import type { Temporal } from "@js-temporal/polyfill";
import { dayStartMs } from "@kichijitsu/web/layout/dayTime";
import type { AllDayOccurrence, Occurrence } from "@kichijitsu/web/model/types";
import { allDaysOnDate, occurrencesByDay, occurrencesInRange, type CalendarData } from "./calendarData";

export interface DayEvents {
  allDay: AllDayOccurrence[];
  timed: Occurrence[];
}

/**
 * 一覧・月表示に出す予定か。勤務場所と辞退した予定は出さない。
 * 不在は出す(作った不在を、確認・削除できるように。タイムラインでは背景として描く)。
 */
function isCardEvent(o: { isWorkingLocation?: boolean; responseStatus?: string }) {
  return !o.isWorkingLocation && o.responseStatus !== "declined";
}

export function eventsOnDate(data: CalendarData, date: Temporal.PlainDate, timeZone: string): DayEvents {
  const start = dayStartMs(date, timeZone);
  const end = dayStartMs(date.add({ days: 1 }), timeZone);
  return {
    allDay: allDaysOnDate(data, date).filter(isCardEvent),
    timed: occurrencesInRange(data, start, end).filter(isCardEvent),
  };
}

/** 複数の日ぶんの予定を、日付 (YYYY-MM-DD) ごとに返す。範囲全体で 1 回だけ展開する(月表示用)。 */
export function eventsByDates(
  data: CalendarData,
  dates: Temporal.PlainDate[],
  timeZone: string,
): Map<string, DayEvents> {
  const timed = occurrencesByDay(data, dates, timeZone);
  const out = new Map<string, DayEvents>();
  for (const date of dates) {
    out.set(date.toString(), {
      allDay: allDaysOnDate(data, date).filter(isCardEvent),
      timed: (timed.get(date.toString()) ?? []).filter(isCardEvent),
    });
  }
  return out;
}
