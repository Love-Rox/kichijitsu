import { Temporal } from "@js-temporal/polyfill";
import { dayStartMs } from "@kichijitsu/web/layout/dayTime";
import type { AllDayOccurrence, EventAttendee, Occurrence } from "@kichijitsu/web/model/types";
import type { EventSeries } from "@kichijitsu/web/model/series";
import { seriesOccurrencesInRange, type CalendarData } from "./calendarData";
import { stripHtml } from "./format";
import type { EventSubject } from "./mutations";

/**
 * 予定の検索。手元(SQLite から読んだ CalendarData)だけで完結する。タイトル・場所・説明・ゲスト
 * (名前とメール)を、空白区切りのすべての語を含む(AND)で探す。全角/半角・大文字小文字は区別しない。
 * 繰り返しの予定は、全件を展開せず、一致したシリーズだけを前後の範囲で展開する。
 */
const PAST_DAYS = 90;
const FUTURE_DAYS = 180;
const MAX_HITS = 100;

export interface SearchHit {
  subject: EventSubject;
  /** 並べ替え用の開始時刻(終日は、その日の開始)。 */
  startMs: number;
  /** 終わっていないか(「これから」に分ける)。 */
  upcoming: boolean;
}

const normalize = (s: string) => s.normalize("NFKC").toLowerCase();

function haystack(o: {
  title: string;
  location?: string;
  description?: string;
  attendees?: EventAttendee[];
}): string {
  const guests = (o.attendees ?? []).map((a) => `${a.displayName ?? ""} ${a.email ?? ""}`).join(" ");
  return normalize(`${o.title} ${o.location ?? ""} ${o.description ? stripHtml(o.description) : ""} ${guests}`);
}

export function searchEvents(data: CalendarData, query: string, nowMs: number, timeZone: string): SearchHit[] {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const matches = (o: Parameters<typeof haystack>[0]) => {
    const h = haystack(o);
    return tokens.every((t) => h.includes(t));
  };
  const skip = (o: { isMirror?: boolean; isWorkingLocation?: boolean }) => o.isMirror || o.isWorkingLocation;

  const hits = new Map<string, SearchHit>();
  const addTimed = (o: Occurrence) => {
    if (skip(o) || hits.has(o.id)) return;
    hits.set(o.id, { subject: o, startMs: o.startMs, upcoming: o.endMs >= nowMs });
  };
  for (const o of data.singles) if (matches(o)) addTimed(o);
  for (const o of data.allDays as AllDayOccurrence[]) {
    if (skip(o) || !matches(o) || hits.has(o.id)) continue;
    const startMs = dayStartMs(Temporal.PlainDate.from(o.startDate), timeZone);
    const endMs = dayStartMs(Temporal.PlainDate.from(o.endDate).add({ days: 1 }), timeZone);
    hits.set(o.id, { subject: o, startMs, upcoming: endMs > nowMs });
  }
  const from = nowMs - PAST_DAYS * 86_400_000;
  const to = nowMs + FUTURE_DAYS * 86_400_000;
  for (const series of data.series as EventSeries[]) {
    if (!matches(series)) continue;
    for (const o of seriesOccurrencesInRange(data, series, from, to)) addTimed(o);
  }

  const all = [...hits.values()];
  const upcoming = all.filter((h) => h.upcoming).sort((a, b) => a.startMs - b.startMs);
  const past = all.filter((h) => !h.upcoming).sort((a, b) => b.startMs - a.startMs);
  return [...upcoming, ...past].slice(0, MAX_HITS);
}
