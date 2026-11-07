const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";

/**
 * 「これ以降」でのシリーズ分割 (2026-11-07) の Google 呼び出し層。
 * 呼び出し元が status を見て 401 リトライとエラー変換を行うため、response をそのまま返し
 * throw しない (他の google/*.ts と同じ層分担)。
 */

function eventsUrl(calendarId: string): string {
  return `${CALENDAR_BASE}/${encodeURIComponent(calendarId)}/events`;
}

/**
 * 親と同じ iCalUID を持つイベント (親 + 個別に変更/削除した回) を取る。
 * showDeleted=true で、削除した回 (status: cancelled の例外) も含める。
 * ページングは扱わない: 1ページ (250件) に収まらないシリーズは呼び出し側が断る。
 */
export async function listSeriesEventsRaw(
  fetchFn: typeof fetch,
  accessToken: string,
  calendarId: string,
  iCalUID: string,
): Promise<Response> {
  const params = new URLSearchParams({ iCalUID, showDeleted: "true", maxResults: "250" });
  return fetchFn(`${eventsUrl(calendarId)}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/** 新シリーズを作る。sendUpdates=all: 新しい招待が届かないと「足したのに届いていない」になる */
export async function insertSeriesRaw(
  fetchFn: typeof fetch,
  accessToken: string,
  calendarId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const params = new URLSearchParams({ sendUpdates: "all", conferenceDataVersion: "1" });
  return fetchFn(`${eventsUrl(calendarId)}?${params.toString()}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 親の recurrence だけを差し替える (UNTIL で打ち切る)。他のフィールドは patch なので触らない */
export async function patchRecurrenceRaw(
  fetchFn: typeof fetch,
  accessToken: string,
  calendarId: string,
  eventId: string,
  recurrence: string[],
): Promise<Response> {
  const url = `${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}?sendUpdates=all`;
  return fetchFn(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recurrence }),
  });
}

/** 巻き戻し用: 作ってしまった新シリーズを消す。招待済みの人に取り消しが届くよう all */
export async function deleteSeriesRaw(
  fetchFn: typeof fetch,
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<Response> {
  const url = `${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}?sendUpdates=all`;
  return fetchFn(url, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } });
}
