import type { EventColorRequest } from "@kichijitsu/shared";
import { GoogleApiError } from "./errors";
import { patchEventColor, type PatchEventColorParams } from "../google/event-color";

/** Google のイベント色 colorId。"" は「カレンダーの色に戻す」。 */
const COLOR_IDS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** POST /api/event/color の body 検査。colorId は "1".."11" か "" だけを通す。 */
export function isValidEventColorRequest(body: unknown): body is EventColorRequest {
  if (!body || typeof body !== "object") return false;
  const c = body as Record<string, unknown>;
  if (!isNonEmptyString(c.accountId)) return false;
  if (!isNonEmptyString(c.calendarId)) return false;
  if (!isNonEmptyString(c.eventId)) return false;
  return typeof c.colorId === "string" && (c.colorId === "" || COLOR_IDS.includes(c.colorId));
}

export interface EventColorCoreDeps {
  fetch: typeof fetch;
  getAccessToken: () => Promise<string>;
  forceRefreshAccessToken: () => Promise<string>;
}

/** 予定の色を書き戻す。401 のときだけ、強制リフレッシュして 1 回だけやり直す。 */
export async function patchEventColorWithRetry(
  deps: EventColorCoreDeps,
  params: PatchEventColorParams,
): Promise<void> {
  let accessToken = await deps.getAccessToken();
  let retriedAuth = false;
  for (;;) {
    const response = await patchEventColor(deps.fetch, accessToken, params);
    if (response.status === 401 && !retriedAuth) {
      retriedAuth = true;
      accessToken = await deps.forceRefreshAccessToken();
      continue;
    }
    if (!response.ok) throw new GoogleApiError(response.status, await response.text());
    return;
  }
}
