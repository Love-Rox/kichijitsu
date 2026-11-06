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
import { sessionFingerprint } from "./auth";
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
/** 1 つのアカウントと、そのアカウントの表示中(同期対象)のカレンダー。 */
export interface AccountCalendars {
  accountId: string;
  email: string;
  calendars: CalendarListEntryDTO[];
}

export interface CalendarData {
  /** 連携しているアカウント(複数可)。予定の作成先の候補にもなる。 */
  accounts: AccountCalendars[];
  /** 同期できなかったカレンダー/アカウントの説明(一部の失敗で、全体を止めないため)。 */
  warnings: string[];
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

function compose(
  accounts: AccountCalendars[],
  partitions: Map<string, Partition>,
  warnings: string[] = [],
): CalendarData {
  const data: CalendarData = {
    accounts,
    warnings,
    singles: [],
    allDays: [],
    series: [],
    overrides: [],
  };
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

  // 手元のデータは「いまのセッション」のものでなければ見せない。保存時に、セッション値の
  // 指紋 (SHA-256) を meta に残してあり、一致しなければ(別のユーザーでログインした、
  // セッションが替わった等)、表示する前に全消去する。
  const fingerprint = await sessionFingerprint();
  if (!fingerprint) {
    await clearAll();
    return null;
  }
  if ((await getMeta("cacheSession")) !== fingerprint) {
    await clearAll();
    await setMeta("cacheSession", fingerprint);
  }
  let partitions = await readAll();
  let cachedAccounts = JSON.parse((await getMeta("accounts")) ?? "[]") as AccountCalendars[];
  if (aborted()) return null;
  if (cachedAccounts.length > 0 && partitions.size > 0) {
    onPartial?.(compose(cachedAccounts, partitions));
  }

  try {
    onProgress?.({ phase: "account", done: 0, total: 0 });
    const me = await timed("me", () => apiFetch<MeResponse>("/api/me", { signal }));
    if (aborted()) return null;
    if (!me || !me.connected || me.accounts.length === 0) {
      // サーバーが未ログイン/未連携と答えた: 手元に残っている予定は、他人のものかもしれないので消す
      await clearAll();
      return null;
    }
    // 保存済みのデータの持ち主と、いま答えたアカウントの集まりに、共通するものが1つも無いなら、
    // 別のユーザーのデータなので全消去してやり直す(アカウントを足した・外しただけなら、残りは有効)
    const currentIds = new Set(me.accounts.map((a) => a.id));
    if (cachedAccounts.length > 0 && !cachedAccounts.some((a) => currentIds.has(a.accountId))) {
      await clearAll();
      await setMeta("cacheSession", fingerprint);
      partitions = new Map();
      cachedAccounts = [];
    }

    // 再連携が必要(リフレッシュトークンが失効した)アカウントは同期できないので、飛ばして知らせる
    const warnings: string[] = [];
    const usable = me.accounts.filter((a) => {
      if (a.reauthRequired) warnings.push(`${a.email}: 再ログイン(再連携)が必要です`);
      return !a.reauthRequired;
    });

    onProgress?.({ phase: "calendars", done: 0, total: 0 });
    // アカウントごとのカレンダー一覧は独立なので並行して取る。1つ失敗しても、他は続ける
    const accounts: AccountCalendars[] = [];
    await Promise.all(
      usable.map(async (account) => {
        try {
          const calendars =
            (await timed(`calendars ${account.email}`, () =>
              apiFetch<CalendarListEntryDTO[]>(
                `/api/calendars?accountId=${encodeURIComponent(account.id)}`,
                { signal },
              ),
            )) ?? [];
          const visibleIds = me.visibleCalendars[account.id];
          const targets = calendars.filter((c) =>
            visibleIds && visibleIds.length > 0 ? visibleIds.includes(c.id) : c.primary,
          );
          accounts.push({ accountId: account.id, email: account.email, calendars: targets });
        } catch (e) {
          if (!aborted()) warnings.push(`${account.email}: カレンダーの一覧を取得できませんでした`);
          // 取得できなかったアカウントは、保存済みの分を、そのまま見せ続ける
          const kept = cachedAccounts.find((a) => a.accountId === account.id);
          if (kept) accounts.push(kept);
        }
      }),
    );
    if (aborted()) return null;
    // 元の並び(サーバーが答えたアカウントの順)に揃える
    accounts.sort(
      (x, y) =>
        me.accounts.findIndex((a) => a.id === x.accountId) -
        me.accounts.findIndex((a) => a.id === y.accountId),
    );
    await setMeta("accounts", JSON.stringify(accounts));

    // 表示対象から外れたカレンダー(外れたアカウントを含む)は、保存済みのデータも画面からも外す
    const keep = new Set(accounts.flatMap((a) => a.calendars.map((c) => calKey(a.accountId, c.id))));
    for (const key of [...partitions.keys()]) if (!keep.has(key)) partitions.delete(key);
    await dropCalendarsExcept(keep);

    const deviceId = await getDeviceId();
    const jobs = accounts.flatMap((a) => a.calendars.map((cal) => ({ account: a, cal })));
    let done = 0;
    onProgress?.({ phase: "sync", done, total: jobs.length });
    // カレンダーごとの同期は互いに独立なので並行して取る(直列だと待ち時間が足し算になる)。
    // 1 つ失敗しても全体は止めず、警告として知らせる。
    await Promise.all(
      jobs.map(async ({ account, cal }) => {
        try {
          const sync = await timed(`sync ${cal.summary}`, () =>
            apiFetch<SyncResponse>("/api/sync", {
              method: "POST",
              body: JSON.stringify({ accountId: account.accountId, calendarId: cal.id, deviceId }),
              signal,
            }),
          );
          if (aborted() || !sync) return;
          const mapped = await timed(`map ${cal.summary} (${sync.events.length} events)`, () =>
            mapGoogleEvents(sync.events, {
              accountId: account.accountId,
              calendarId: cal.id,
              defaultColor: cal.backgroundColor,
            }),
          );
          if (aborted()) return;
          await applySync(account.accountId, cal.id, mapped, sync.isFullSync, signal);
          if (aborted()) return;
          partitions.set(
            calKey(account.accountId, cal.id),
            await readPartition(account.accountId, cal.id),
          );
        } catch (e) {
          if (__DEV__) console.log(`SYNCERR ${cal.summary} ${String(e)}`);
          if (!aborted()) warnings.push(`${cal.summary}(${account.email}): 同期できませんでした`);
        }
        done += 1;
        onProgress?.({ phase: "sync", done, total: jobs.length });
        onPartial?.(compose(accounts, partitions, [...warnings]));
      }),
    );
    return aborted() ? null : compose(accounts, partitions, warnings);
  } catch (e) {
    // 通信に失敗しても、手元のデータがあればそれを見せる(オフライン)
    if (!aborted() && cachedAccounts.length > 0 && partitions.size > 0) {
      return compose(cachedAccounts, partitions);
    }
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
