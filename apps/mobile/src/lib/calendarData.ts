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

/** 開発用の計測ログ。Metro のログに `PERF label ms` で出る。 */
async function timed<T>(label: string, run: () => Promise<T> | T): Promise<T> {
  const t0 = Date.now();
  const result = await run();
  if (__DEV__) console.log(`PERF ${label} ${Date.now() - t0}ms`);
  return result;
}

/** 読み込みの進み具合 (画面の「読み込み中」表示用)。 */
export interface LoadProgress {
  /** いま何をしているか */
  phase: "account" | "calendars" | "sync";
  /** sync のとき: 完了したカレンダー数 / 全体 */
  done: number;
  total: number;
}

export async function loadCalendarData(
  onProgress?: (p: LoadProgress) => void,
): Promise<CalendarData | null> {
  onProgress?.({ phase: "account", done: 0, total: 0 });
  const me = await timed("me", () => apiFetch<MeResponse>("/api/me"));
  if (!me || !me.connected || me.accounts.length === 0) return null;
  const account = me.accounts[0];

  const calendars =
    (await timed("calendars", () =>
      apiFetch<CalendarListEntryDTO[]>(`/api/calendars?accountId=${encodeURIComponent(account.id)}`),
    )) ?? [];
  onProgress?.({ phase: "calendars", done: 0, total: 0 });
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
  let done = 0;
  onProgress?.({ phase: "sync", done, total: targets.length });
  // カレンダーごとの同期は互いに独立なので並行して取る(直列だと待ち時間が足し算になる。
  // 計測: 9 カレンダーの合計 約 17 秒のうち、サーバーの同期が約 14 秒で、最大の 1 件が約 6 秒)。
  const results = await Promise.all(
    targets.map(async (cal) => {
      const sync = await timed(`sync ${cal.summary}`, () =>
        apiFetch<SyncResponse>("/api/sync", {
          method: "POST",
          body: JSON.stringify({
            accountId: account.id,
            calendarId: cal.id,
            deviceId: DEVICE_ID,
            forceFull: true,
          }),
        }),
      );
      const events: GoogleEventDTO[] = sync?.events ?? [];
      const mapped = await timed(`map ${cal.summary} (${events.length} events)`, () =>
        mapGoogleEvents(events, {
          accountId: account.id,
          calendarId: cal.id,
          defaultColor: cal.backgroundColor,
        }),
      );
      done += 1;
      onProgress?.({ phase: "sync", done, total: targets.length });
      return mapped;
    }),
  );
  for (const mapped of results) {
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
