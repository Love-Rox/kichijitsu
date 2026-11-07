import type { EventSendUpdates } from "@kichijitsu/shared";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";

export interface AddEventMeetParams {
  calendarId: string;
  eventId: string;
  /** ゲストへの通知。optional にしない(core/patch-event.ts の resolveSendUpdates を呼び出し側が必ず通す) */
  sendUpdates: EventSendUpdates;
  /** Google の冪等キー。同じ値で再送しても、会議は 1 つしか作られない */
  requestId: string;
}

/**
 * `events.patch` で、既存の予定に Google Meet の会議を追加する。`conferenceDataVersion=1` が無いと、
 * Google は conferenceData を無視する(エラーにもならず、黙って何も起きない)ので、必ず付ける。
 * 他のフィールドは body に含めないので、Google 側の値はそのまま保たれる。
 * 呼び出し元 (core/event-meet.ts) が status を見て 401 リトライとエラー変換を行うため、response を
 * そのまま返し throw しない(他の google/*.ts と同じ層分担)。
 */
export async function addEventMeet(
  fetchFn: typeof fetch,
  accessToken: string,
  params: AddEventMeetParams,
): Promise<Response> {
  const url =
    `${CALENDAR_BASE}/${encodeURIComponent(params.calendarId)}/events/${encodeURIComponent(params.eventId)}` +
    `?conferenceDataVersion=1&sendUpdates=${params.sendUpdates}`;
  return fetchFn(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      conferenceData: {
        createRequest: {
          requestId: params.requestId,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    }),
  });
}
