import type { GoogleEventDTO } from "@kichijitsu/shared";

/** Google Calendar API `events.list` の応答から必要なフィールドだけを写した型。 */
interface RawGoogleEvent {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: { dateTime?: string; date?: string; timeZone?: string };
  updated?: string;
  colorId?: string;
  htmlLink?: string;
  iCalUID?: string;
  location?: string;
  description?: string;
}

interface RawEventsListResponse {
  items: RawGoogleEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export function toGoogleEventDTO(raw: RawGoogleEvent): GoogleEventDTO {
  return {
    id: raw.id,
    status: raw.status,
    summary: raw.summary,
    start: raw.start,
    end: raw.end,
    recurrence: raw.recurrence,
    recurringEventId: raw.recurringEventId,
    originalStartTime: raw.originalStartTime,
    updated: raw.updated,
    colorId: raw.colorId,
    htmlLink: raw.htmlLink,
    iCalUID: raw.iCalUID,
    location: raw.location,
    description: raw.description,
  };
}

const EVENTS_LIST_BASE = "https://www.googleapis.com/calendar/v3/calendars";

export interface ListEventsPageParams {
  /** 初回ページのみ指定 (増分同期)。ページ 2 以降は pageToken だけを使う。 */
  syncToken?: string;
  pageToken?: string;
}

/**
 * events.list を 1 ページ分呼び出す。
 *
 * singleEvents=false は固定。syncToken は「取得時と同じクエリパラメータでしか
 * 使えない」という Google 側の制約があるため、増分同期・全同期の両方で必ず
 * 同じパラメータ構成 (maxResults, singleEvents) を使うこと。
 *
 * timeMin/timeMax は意図的に付与しない: これらは nextSyncToken の発行 (=
 * 差分同期の起点) と併用できないため、付けると全期間の差分同期ができなくなる。
 */
export function buildEventsListUrl(calendarId: string, params: ListEventsPageParams): string {
  const url = new URL(`${EVENTS_LIST_BASE}/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("maxResults", "2500");
  url.searchParams.set("singleEvents", "false");
  if (params.pageToken) {
    // ページ継続時は pageToken のみ (syncToken は初回リクエストの文脈を引き継ぐ)
    url.searchParams.set("pageToken", params.pageToken);
  } else if (params.syncToken) {
    url.searchParams.set("syncToken", params.syncToken);
  }
  return url.toString();
}

export async function fetchEventsPage(
  fetchFn: typeof fetch,
  accessToken: string,
  calendarId: string,
  params: ListEventsPageParams,
): Promise<Response> {
  return fetchFn(buildEventsListUrl(calendarId, params), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export async function parseEventsListResponse(response: Response): Promise<RawEventsListResponse> {
  return (await response.json()) as RawEventsListResponse;
}
