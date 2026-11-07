import type { EventMeetRequest } from "@kichijitsu/shared";
import { GoogleApiError } from "./errors";
import { addEventMeet } from "../google/event-meet";
import { deriveConferenceUrl } from "./google-events";
import { DEFAULT_SEND_UPDATES } from "./patch-event";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** POST /api/event/meet の body 検査。 */
export function isValidEventMeetRequest(body: unknown): body is EventMeetRequest {
  if (!body || typeof body !== "object") return false;
  const c = body as Record<string, unknown>;
  return isNonEmptyString(c.accountId) && isNonEmptyString(c.calendarId) && isNonEmptyString(c.eventId);
}

export interface EventMeetCoreDeps {
  fetch: typeof fetch;
  getAccessToken: () => Promise<string>;
  forceRefreshAccessToken: () => Promise<string>;
}

/**
 * Google の応答から、会議の参加 URL を取り出す。同期が予定の会議 URL を決める関数
 * (core/google-events.ts の deriveConferenceUrl)をそのまま使うので、**http/https の URL だけ**が
 * 通り(tel: や javascript: などは除外)、同期があとで入れる URL とも必ず一致する。この値は
 * 画面でリンク(href)になるので、スキームの検査を、ここで通さずに返さない。
 * 会議がまだ作られている途中(status が pending)などで、URL が無いときは undefined
 * (予定のほうには、次の同期でリンクが入る)。
 */
export function conferenceUrlFrom(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const e = event as { hangoutLink?: unknown; conferenceData?: unknown };
  return deriveConferenceUrl(
    e.conferenceData,
    typeof e.hangoutLink === "string" ? e.hangoutLink : undefined,
  );
}

/**
 * 既存の予定に Meet を追加する。401 のときだけ、強制リフレッシュして 1 回だけやり直す。
 * 会議の作成そのものが失敗した (createRequest.status が failure) ときは、Google は 200 を返しつつ
 * リンクを付けないので、エラーとして扱う(黙って成功にすると、リンクが付かないまま画面だけ進む)。
 */
export async function addEventMeetWithRetry(
  deps: EventMeetCoreDeps,
  params: { calendarId: string; eventId: string },
  newRequestId: () => string = () => crypto.randomUUID(),
): Promise<{ conferenceUrl?: string }> {
  let accessToken = await deps.getAccessToken();
  let retriedAuth = false;
  // 401 でやり直すときも同じ requestId を使う(Google 側で、会議が二重に作られないように)
  const requestId = newRequestId();
  for (;;) {
    const response = await addEventMeet(deps.fetch, accessToken, {
      ...params,
      sendUpdates: DEFAULT_SEND_UPDATES,
      requestId,
    });
    if (response.status === 401 && !retriedAuth) {
      retriedAuth = true;
      accessToken = await deps.forceRefreshAccessToken();
      continue;
    }
    if (!response.ok) throw new GoogleApiError(response.status, await response.text());
    const event: unknown = await response.json().catch(() => undefined);
    const failed =
      (event as { conferenceData?: { createRequest?: { status?: { statusCode?: unknown } } } } | undefined)
        ?.conferenceData?.createRequest?.status?.statusCode === "failure";
    if (failed) throw new GoogleApiError(502, "conference creation failed");
    return { conferenceUrl: conferenceUrlFrom(event) };
  }
}
