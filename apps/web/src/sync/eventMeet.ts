import type { EventMeetRequest } from "@kichijitsu/shared";
import type { Occurrence } from "../model/types";
import { isEditableEventSubject } from "./eventEdit";
import { rawGoogleEventId } from "./eventPatch";

/**
 * 既存の予定に Google Meet の会議を追加する POST /api/event/meet の、リクエスト組み立ての純関数群。
 * 繰り返しの予定は、シリーズ全体(親の id)に会議を付ける ―― 会議のリンクは、回ごとではなく、
 * 繰り返しの予定そのものに付くのが普通なため。手元では、操作した回だけ先に更新し、ほかの回は
 * 次の同期でリンクが入る。
 */

/** 予定の部品が、Meet の追加が出せるかの判定に使う最小形。 */
export interface MeetSubject {
  id: string;
  title: string;
  source: Occurrence["source"];
  accountId?: string;
  calendarId?: string;
  seriesId?: string | null;
  isMirror?: boolean;
  isOutOfOffice?: boolean;
  isWorkingLocation?: boolean;
  hasConference?: boolean;
  conferenceUrl?: string;
  location?: string;
}

/** 予定に Meet の会議を追加する関数(useEventMutations の addMeet)。画面の部品へ props で流す。 */
export type AddEventMeet = (subject: Occurrence) => Promise<void>;

/**
 * Meet を追加できる予定か: 編集できる Google の予定(ミラー・Busy は除く)で、書き込み先が分かり、
 * まだ会議が無いもの。不在・勤務場所は対象外。location に会議の URL が入っている予定
 * (Slack ハドルなど)は、画面側が「参加リンクあり」と見て、ボタンを出さない。
 */
export function canAddMeet(subject: MeetSubject): boolean {
  return (
    isEditableEventSubject(subject) &&
    !!subject.accountId &&
    !!subject.calendarId &&
    subject.isOutOfOffice !== true &&
    subject.isWorkingLocation !== true &&
    subject.hasConference !== true &&
    !subject.conferenceUrl
  );
}

/**
 * subject から POST /api/event/meet の body を作る。追加できない相手・id のパースに失敗した相手は null。
 * シリーズ由来の1回分は、親のシリーズ全体に付ける。
 */
export function buildEventMeetRequest(subject: MeetSubject): EventMeetRequest | null {
  if (!canAddMeet(subject)) return null;
  try {
    return {
      accountId: subject.accountId!,
      calendarId: subject.calendarId!,
      eventId: rawGoogleEventId(subject.seriesId ? subject.seriesId : subject.id),
    };
  } catch (err) {
    console.error("kichijitsu: failed to build EventMeetRequest", err);
    return null;
  }
}

