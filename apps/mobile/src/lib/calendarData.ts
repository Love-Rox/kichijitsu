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
import {
  applySync,
  calKey,
  clearAll,
  dropCalendarsExcept,
  getDeviceId,
  getMeta,
  readAll,
  readPartition,
  setMeta,
  type Partition,
} from "./localDb";

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

export interface LoadOptions {
  onProgress?: (p: LoadProgress) => void;
  /** 手元のデータを出したとき・カレンダーが1つ同期できるたびに、そこまでのデータで呼ばれる。 */
  onPartial?: (data: CalendarData) => void;
  /** 中止の合図。ログアウトや再読み込みで立つ。立ったら、以後データベースへも画面へも書かない。 */
  signal?: AbortSignal;
}

function compose(email: string, partitions: Map<string, Partition>): CalendarData {
  const data: CalendarData = { email, singles: [], allDays: [], series: [], overrides: [] };
  for (const p of partitions.values()) {
    data.singles.push(...p.singles);
    data.allDays.push(...p.allDays);
    data.series.push(...p.series);
    data.overrides.push(...p.overrides);
  }
  return data;
}

/**
 * ローカルファースト: まず手元に保存済みのデータを出し(あれば即座に)、そのあとサーバーと
 * **差分だけ**同期して、取れたカレンダーから順に反映する。
 *   - 初回(保存なし)は全件の同期になる。以後は、サーバーが端末ごと (deviceId) に持つ同期位置から
 *     の差分だけなので、重いカレンダー(7011 件)でも小さくて済む。
 *   - ネットワークに繋がらなくても、保存済みのデータは見られる。
 */
export async function loadCalendarData(options: LoadOptions = {}): Promise<CalendarData | null> {
  const { onProgress, onPartial, signal } = options;
  const aborted = () => signal?.aborted === true;

  const partitions = await readAll();
  const cachedEmail = await getMeta("email");
  if (aborted()) return null;
  if (cachedEmail && partitions.size > 0) onPartial?.(compose(cachedEmail, partitions));

  try {
    onProgress?.({ phase: "account", done: 0, total: 0 });
    const me = await timed("me", () => apiFetch<MeResponse>("/api/me", { signal }));
    if (aborted()) return null;
    if (!me || !me.connected || me.accounts.length === 0) {
      // サーバーが未ログイン/未連携と答えた: 手元に残っている予定は、他人のものかもしれないので消す
      await clearAll();
      return null;
    }
    const account = me.accounts[0];
    await setMeta("email", account.email);

    onProgress?.({ phase: "calendars", done: 0, total: 0 });
    const calendars =
      (await timed("calendars", () =>
        apiFetch<CalendarListEntryDTO[]>(`/api/calendars?accountId=${encodeURIComponent(account.id)}`, {
          signal,
        }),
      )) ?? [];
    if (aborted()) return null;
    const visibleIds = me.visibleCalendars[account.id];
    const targets = calendars.filter((c) =>
      visibleIds && visibleIds.length > 0 ? visibleIds.includes(c.id) : c.primary,
    );

    // 表示対象から外れたカレンダーは、保存済みのデータも画面からも外す
    const keep = new Set(targets.map((c) => calKey(account.id, c.id)));
    for (const key of [...partitions.keys()]) if (!keep.has(key)) partitions.delete(key);
    await dropCalendarsExcept(keep);

    const deviceId = await getDeviceId();
    let done = 0;
    onProgress?.({ phase: "sync", done, total: targets.length });
    // カレンダーごとの同期は互いに独立なので並行して取る(直列だと待ち時間が足し算になる)
    await Promise.all(
      targets.map(async (cal) => {
        const sync = await timed(`sync ${cal.summary}`, () =>
          apiFetch<SyncResponse>("/api/sync", {
            method: "POST",
            body: JSON.stringify({ accountId: account.id, calendarId: cal.id, deviceId }),
            signal,
          }),
        );
        if (aborted() || !sync) return;
        const mapped = await timed(`map ${cal.summary} (${sync.events.length} events)`, () =>
          mapGoogleEvents(sync.events, {
            accountId: account.id,
            calendarId: cal.id,
            defaultColor: cal.backgroundColor,
          }),
        );
        if (aborted()) return;
        await applySync(account.id, cal.id, mapped, sync.isFullSync);
        if (aborted()) return;
        partitions.set(calKey(account.id, cal.id), await readPartition(account.id, cal.id));
        done += 1;
        onProgress?.({ phase: "sync", done, total: targets.length });
        onPartial?.(compose(account.email, partitions));
      }),
    );
    return aborted() ? null : compose(account.email, partitions);
  } catch (e) {
    // 通信に失敗しても、手元のデータがあればそれを見せる(オフライン)
    if (!aborted() && cachedEmail && partitions.size > 0) return compose(cachedEmail, partitions);
    throw e;
  }
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
