import type { RsvpResponseStatus } from "@kichijitsu/shared";
import { NotAnAttendeeError } from "./errors";
import { parseEventAttendees, patchAttendeesRaw, type RawAttendee } from "../google/rsvp-raw";
import { updateAttendeesWithRetry, type AttendeeWriteDeps } from "./attendee-write";

/**
 * UserSyncDO.rsvpEvent が実装すべき依存先。他の core/*.ts (patch-event.ts 等) と同じ
 * { fetch, getAccessToken, forceRefreshAccessToken } 形なので、DO 側は
 * buildEventWriteDeps を共用できる。
 */
export type RsvpEventCoreDeps = AttendeeWriteDeps;

export interface RsvpEventParams {
  calendarId: string;
  eventId: string;
  responseStatus: RsvpResponseStatus;
}

/**
 * 自分の参加ステータス (RSVP) を Google へ書き戻す。Google Calendar API に RSVP 専用
 * エンドポイントは無く、attendees 配列は `events.patch` でも全置換 (マージではない) と
 * なるため、read-modify-write が必須:
 *   1. `events.get` で現在の attendees を取得
 *   2. self (attendee.self===true) のエントリの responseStatus だけを差し替える
 *      (他のエントリ・他のフィールドはそのまま保持して書き戻す)
 *   3. `events.patch` (sendUpdates=all) で attendees 配列全体を書き戻す
 * self が見つからない (自分だけの予定・招待されていない予定) 場合は NotAnAttendeeError
 * を投げる — route 側 (rpc-result.ts の runRpc) がこれを 422 not_an_attendee に変換する。
 *
 * 1 と 3 (と 401 リトライ) はゲスト編集 (core/guest-event.ts) とまったく同じなので
 * core/attendee-write.ts に出してある。**この関数に残っているのは 2 の判断だけ**。
 */
export async function rsvpEventWithRetry(
  deps: RsvpEventCoreDeps,
  params: RsvpEventParams,
): Promise<void> {
  return updateAttendeesWithRetry(deps, params, {
    patchAttendees: patchAttendeesRaw,
    resolveNext: async (response) => {
      const attendees = await parseEventAttendees(response);
      const selfIndex = attendees.findIndex((attendee) => attendee.self === true);
      if (selfIndex === -1) {
        throw new NotAnAttendeeError();
      }
      const updated: RawAttendee[] = attendees.map((attendee, index) =>
        index === selfIndex ? { ...attendee, responseStatus: params.responseStatus } : attendee,
      );
      return updated;
    },
  });
}
