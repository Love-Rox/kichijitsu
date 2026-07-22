import type { CalendarListEntryDTO } from "@kichijitsu/shared";
import { GoogleApiError } from "../core/errors";

interface RawCalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
  backgroundColor?: string;
  accessRole?: "owner" | "writer" | "reader" | "freeBusyReader";
}

interface RawCalendarListResponse {
  items: RawCalendarListEntry[];
}

export async function fetchCalendarList(
  fetchFn: typeof fetch,
  accessToken: string,
): Promise<CalendarListEntryDTO[]> {
  const response = await fetchFn("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new GoogleApiError(response.status, await response.text());
  }
  const data = (await response.json()) as RawCalendarListResponse;
  return data.items.map((item) => ({
    id: item.id,
    summary: item.summary,
    primary: item.primary,
    backgroundColor: item.backgroundColor,
    accessRole: item.accessRole,
  }));
}
