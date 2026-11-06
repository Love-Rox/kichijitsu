import type { Temporal } from "@js-temporal/polyfill";
import { dayStartMs } from "@kichijitsu/web/layout/dayTime";
import type { AllDayOccurrence, Occurrence } from "@kichijitsu/web/model/types";
import { allDaysOnDate, occurrencesInRange, type CalendarData } from "./calendarData";

export interface DayEvents {
  allDay: AllDayOccurrence[];
  timed: Occurrence[];
}

/** 一覧・月表示に出す予定か。不在・勤務場所・辞退した予定は、タイムライン同様に通常カードとして出さない。 */
function isCardEvent(o: { isOutOfOffice?: boolean; isWorkingLocation?: boolean; responseStatus?: string }) {
  return !o.isOutOfOffice && !o.isWorkingLocation && o.responseStatus !== "declined";
}

export function eventsOnDate(data: CalendarData, date: Temporal.PlainDate, timeZone: string): DayEvents {
  const start = dayStartMs(date, timeZone);
  const end = dayStartMs(date.add({ days: 1 }), timeZone);
  return {
    allDay: allDaysOnDate(data, date).filter(isCardEvent),
    timed: occurrencesInRange(data, start, end).filter(isCardEvent),
  };
}
