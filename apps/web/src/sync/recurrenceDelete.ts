import { Temporal } from "@js-temporal/polyfill";
import type { EventDeleteRequest } from "@kichijitsu/shared";
import { expandSeries } from "../expansion/expandSeries";
import { plainDateOfMs } from "../layout/dayTime";
import type { InstanceOverride, EventSeries } from "../model/series";
import type { AllDayOccurrence, Occurrence } from "../model/types";
import { rawGoogleEventId } from "./eventPatch";
import { resolveSendUpdates, type GuestNotify } from "./guestNotify";

/**
 * 繰り返し予定の削除の範囲 (2026-11-09)。
 *
 * - "this": この回だけ(従来どおり。インスタンスをキャンセルする)
 * - "range": この回から、指定した日まで(連続した回をまとめて消す)
 * - "all": シリーズ全体(親の予定を消す)
 *
 * 編集の適用範囲 (recurrenceScope.ts の RecurrenceScope) とは別の型にしてある。編集の
 * 「これ以降」は Google API に手段が無く安全に作れないが、削除の「範囲」は**1回ずつの
 * キャンセルを繰り返すだけ**で作れるため、同じ型に混ぜると「編集にも range がある」ように
 * 読めてしまう。
 */
export type DeleteScope = "this" | "range" | "all";

/** 「この回から指定の日まで」で一度に消せる回数の上限。書き込みは 1 回ずつ送るので、暴走を防ぐ。 */
export const MAX_RANGE_DELETE = 100;

/** 繰り返しの回を持つ Google の予定か(削除の範囲を訊く対象)。終日は繰り返しを持たない。 */
export function isRecurringGoogleOccurrence(
  occurrence: Occurrence | AllDayOccurrence,
): occurrence is Occurrence {
  return (
    occurrence.source === "google" &&
    "startMs" in occurrence &&
    occurrence.seriesId !== null &&
    occurrence.seriesId !== undefined &&
    occurrence.originalStartMs !== undefined
  );
}

/**
 * 「すべて」の削除: シリーズの親の event id を宛先にする。
 * 親を消すと Google がすべての回(例外の回を含む)を消す。
 */
export function buildSeriesDeleteRequest(
  occurrence: Occurrence,
  notify?: GuestNotify,
): EventDeleteRequest | null {
  if (
    occurrence.source !== "google" ||
    !occurrence.accountId ||
    !occurrence.calendarId ||
    !occurrence.seriesId
  ) {
    return null;
  }
  try {
    return {
      accountId: occurrence.accountId,
      calendarId: occurrence.calendarId,
      eventId: rawGoogleEventId(occurrence.seriesId),
      sendUpdates: resolveSendUpdates(occurrence, notify),
    };
  } catch (err) {
    console.error("kichijitsu: failed to build series EventDeleteRequest", err);
    return null;
  }
}

/** 範囲の最後の日の「次の日の 0 時」(含めない端)。 */
function endExclusiveMs(until: Temporal.PlainDate, timeZone: string): number {
  return until.add({ days: 1 }).toZonedDateTime({ timeZone }).epochMilliseconds;
}

/**
 * 「この回から指定の日まで」の対象になる回を、開始順に返す。
 *
 * シリーズと例外(キャンセル済みの回は展開から外れる)を展開して数えるので、すでに消えている回は
 * 含まれない。`from` の回は必ず先頭に入る。`until` は表示のタイムゾーンの日付で、その日を含む。
 * `until` が `from` の日より前なら、`from` の 1 回だけ。
 */
export function instancesInRange(
  series: EventSeries,
  overrides: readonly InstanceOverride[],
  from: Occurrence,
  until: Temporal.PlainDate,
  timeZone: string,
): Occurrence[] {
  const fromDay = plainDateOfMs(from.startMs, timeZone);
  const lastDay = Temporal.PlainDate.compare(until, fromDay) < 0 ? fromDay : until;
  const expanded = expandSeries({
    series,
    overrides: overrides.filter((o) => o.seriesId === series.id) as InstanceOverride[],
    windowStartMs: from.startMs,
    windowEndMs: endExclusiveMs(lastDay, timeZone),
  });
  const rest = expanded.filter((o) => o.id !== from.id && o.startMs >= from.startMs);
  return [from, ...rest].sort((a, b) => a.startMs - b.startMs);
}
