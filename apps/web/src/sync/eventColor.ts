import type { EventColorRequest } from "@kichijitsu/shared";
import type { AllDayOccurrence, Occurrence } from "../model/types";
import { rawGoogleEventId, seriesInstanceEventId } from "./eventPatch";
import type { RecurrenceScope } from "./recurrenceScope";

/**
 * 予定の色(Google の colorId)を変える POST /api/event/color の、リクエスト組み立ての純関数群。
 * 色は見た目の属性なので、ゲストへのメールは出ない(サーバー側で sendUpdates=none)。
 */

/** 予定の色を変える関数(useEventMutations の setColor)。画面の部品へ props で流す。 */
export type SetEventColor = (
  subject: Occurrence | AllDayOccurrence,
  colorId: string | null,
  calendarColor: string,
  /** 繰り返しの予定の適用範囲。省略は「この回だけ」。繰り返しでない予定では無視される */
  scope?: RecurrenceScope,
) => Promise<void>;

/** buildEventColorRequest が必要とする最小形(Occurrence / AllDayOccurrence の共通部分)。 */
export interface ColorEditSubject {
  id: string;
  source?: string;
  accountId?: string;
  calendarId?: string;
  /** シリーズ由来の1回分なら、親の series id と、展開時の元の開始時刻 */
  seriesId?: string | null;
  originalStartMs?: number;
}

/** 色を変えられる予定か: Google の予定で、書き込み先(アカウント・カレンダー)が分かるもの。 */
export function canSetEventColor(subject: ColorEditSubject): boolean {
  return subject.source === "google" && !!subject.accountId && !!subject.calendarId;
}

/**
 * subject と colorId から POST /api/event/color の body を作る。colorId が null なら、予定個別の色を外す
 * (サーバーへは空文字で送る)。変えられない相手・id のパースに失敗した相手は null。
 * シリーズ由来の1回分は、scope が "this"(省略時)ならその回だけ(Google のインスタンス ID)、
 * "all" ならシリーズ全体(親の event id)の色を変える。
 */
export function buildEventColorRequest(
  subject: ColorEditSubject,
  colorId: string | null,
  scope: RecurrenceScope = "this",
): EventColorRequest | null {
  if (!canSetEventColor(subject)) return null;
  try {
    const eventId =
      subject.seriesId && scope === "all"
        ? rawGoogleEventId(subject.seriesId)
        : subject.seriesId && subject.originalStartMs !== undefined
          ? seriesInstanceEventId(subject.seriesId, subject.originalStartMs)
          : rawGoogleEventId(subject.id);
    return {
      accountId: subject.accountId!,
      calendarId: subject.calendarId!,
      eventId,
      colorId: colorId ?? "",
    };
  } catch (err) {
    console.error("kichijitsu: failed to build EventColorRequest", err);
    return null;
  }
}
