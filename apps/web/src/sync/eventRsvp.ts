import type { EventRsvpRequest, RsvpResponseStatus } from "@kichijitsu/shared";
import type { AllDayOccurrence, Occurrence } from "../model/types";
import { rawGoogleEventId, seriesInstanceEventId } from "./eventPatch";

/**
 * RSVP (自分の参加ステータス変更、2026-07-22) に関する純関数群。詳細ポップオーバーの
 * 参加/未定/不参加ボタンから呼ばれる。POST /api/event/rsvp の body 組み立ては
 * sync/eventPatch.ts の buildEventPatchRequest / eventEdit.ts の buildEventEditPatchRequest と
 * 同じ eventId 組み立て規則 (rawGoogleEventId / seriesInstanceEventId) を再利用する。
 */

/**
 * POST /api/event/rsvp が 422 (not_an_attendee) を返したことを示すエラー。
 * 「招待されていない予定には返信できません」という、ネットワーク失敗一般とは違う
 * 専用メッセージを出し分けるために、呼び出し側 (App.tsx の handleRsvp) がこれを throw し、
 * UI 側 (EventBlock.tsx の RsvpButtons) が instanceof で判定する。
 */
export class RsvpNotAttendeeError extends Error {
  constructor() {
    super("not_an_attendee");
    this.name = "RsvpNotAttendeeError";
  }
}

/**
 * occurrence/allDayOccurrence から POST /api/event/rsvp の body を組み立てる。
 * source !== 'google' や accountId/calendarId 欠落、id のパース失敗時は null
 * (呼び出し側で warn する。buildEventPatchRequest と同じ流儀)。
 */
export function buildEventRsvpRequest(
  subject: Occurrence | AllDayOccurrence,
  responseStatus: RsvpResponseStatus,
): EventRsvpRequest | null {
  if (subject.source !== "google" || !subject.accountId || !subject.calendarId) {
    return null;
  }
  try {
    const originalStartMs = "originalStartMs" in subject ? subject.originalStartMs : undefined;
    const eventId =
      subject.seriesId && originalStartMs !== undefined
        ? seriesInstanceEventId(subject.seriesId, originalStartMs)
        : rawGoogleEventId(subject.id);
    return {
      accountId: subject.accountId,
      calendarId: subject.calendarId,
      eventId,
      responseStatus,
    };
  } catch (err) {
    console.error("kichijitsu: failed to build EventRsvpRequest", err);
    return null;
  }
}
