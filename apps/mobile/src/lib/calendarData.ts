import { Temporal } from "@js-temporal/polyfill";
import type {
  CalendarListEntryDTO,
  GoogleEventDTO,
  MeResponse,
  SyncResponse,
} from "@kichijitsu/shared";
import { expandSeries } from "@kichijitsu/web/expansion/expandSeries";
import type { EventSeries, InstanceOverride } from "@kichijitsu/web/model/series";
import type { AllDayOccurrence, Occurrence } from "@kichijitsu/web/model/types";
import { mapGoogleEvents } from "@kichijitsu/web/sync/mapGoogle";
import { apiFetch } from "./api";

/**
 * Worker から予定を取得して、Web 版と同じロジック (mapGoogleEvents / expandSeries) で
 * 表示用の Occurrence に変換する。スパイクなので、手元への保存 (IndexedDB 相当) はまだ無く、
 * 毎回全件を取る(forceFull)。ローカルファースト化は次の段階。
 */
export interface CalendarData {
  email: string;
  singles: Occurrence[];
  allDays: AllDayOccurrence[];
  series: EventSeries[];
  overrides: InstanceOverride[];
}

const DEVICE_ID = "mobile-spike";

export async function loadCalendarData(): Promise<CalendarData | null> {
  const me = await apiFetch<MeResponse>("/api/me");
  if (!me || !me.connected || me.accounts.length === 0) return null;
  const account = me.accounts[0];

  const calendars =
    (await apiFetch<CalendarListEntryDTO[]>(
      `/api/calendars?accountId=${encodeURIComponent(account.id)}`,
    )) ?? [];
  const visibleIds = me.visibleCalendars[account.id];
  const targets = calendars.filter((c) =>
    visibleIds && visibleIds.length > 0 ? visibleIds.includes(c.id) : c.primary,
  );

  const data: CalendarData = {
    email: account.email,
    singles: [],
    allDays: [],
    series: [],
    overrides: [],
  };
  for (const cal of targets) {
    const sync = await apiFetch<SyncResponse>("/api/sync", {
      method: "POST",
      body: JSON.stringify({
        accountId: account.id,
        calendarId: cal.id,
        deviceId: DEVICE_ID,
        forceFull: true,
      }),
    });
    const events: GoogleEventDTO[] = sync?.events ?? [];
    const mapped = mapGoogleEvents(events, {
      accountId: account.id,
      calendarId: cal.id,
      defaultColor: cal.backgroundColor,
    });
    data.singles.push(...mapped.singles);
    data.allDays.push(...mapped.allDays);
    data.series.push(...mapped.series);
    data.overrides.push(...mapped.overrides);
  }
  return data;
}

/** [startMs, endMs) に重なる時刻予定 (単発 + 繰り返しの展開結果) を開始順に返す。 */
export function occurrencesInRange(data: CalendarData, startMs: number, endMs: number): Occurrence[] {
  const out = data.singles.filter((o) => o.startMs < endMs && o.endMs > startMs);
  for (const series of data.series) {
    const overrides = data.overrides.filter((ov) => ov.seriesId === series.id);
    out.push(
      ...expandSeries({ series, overrides, windowStartMs: startMs, windowEndMs: endMs }).filter(
        (o) => o.startMs < endMs && o.endMs > startMs,
      ),
    );
  }
  return out.sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs);
}

/** 日付 (YYYY-MM-DD, 両端含む) が [dayStart, dayEnd) の日に掛かる終日予定。 */
export function allDaysOnDate(data: CalendarData, date: Temporal.PlainDate): AllDayOccurrence[] {
  const d = date.toString();
  return data.allDays.filter((a) => a.startDate <= d && d <= a.endDate);
}
