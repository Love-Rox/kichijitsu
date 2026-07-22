import type { RsvpResponseStatus } from "@kichijitsu/shared";
import { GoogleApiError, NotAnAttendeeError } from "./errors";
import {
  getEventRaw,
  parseEventAttendees,
  patchAttendeesRaw,
  type RawAttendee,
} from "../google/rsvp-raw";

/**
 * UserSyncDO.rsvpEvent が実装すべき依存先。他の core/*.ts (patch-event.ts 等) と同じ
 * { fetch, getAccessToken, forceRefreshAccessToken } 形なので、DO 側は
 * buildEventWriteDeps を共用できる。
 */
export interface RsvpEventCoreDeps {
  fetch: typeof fetch;
  getAccessToken: () => Promise<string>;
  forceRefreshAccessToken: () => Promise<string>;
}

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
 * 401 リトライは他の *WithRetry (patch-event.ts 等) と同じく「1回だけ強制リフレッシュして
 * 再試行」の方針だが、ここでは GET/PATCH の2段構成全体を1つの試行単位として扱う —
 * どちらの呼び出しで 401 が出ても、まだリトライしていなければ forceRefreshAccessToken
 * してから GET からやり直す (2回目の試行では改めて 401 が出ても即座に GoogleApiError
 * として伝播させ、無限ループしない)。GET→PATCH の間で attendees が変わっている
 * 可能性 (競合) はあるが、events.patch に楽観ロック (ETag/If-Match) 相当の仕組みを
 * 使っていない現状ではこれ以上のことはできない — 他の書き込み系 RPC と同じ楽観前提。
 */
export async function rsvpEventWithRetry(
  deps: RsvpEventCoreDeps,
  params: RsvpEventParams,
): Promise<void> {
  let accessToken = await deps.getAccessToken();
  let retriedAuth = false;

  for (;;) {
    const getResponse = await getEventRaw(
      deps.fetch,
      accessToken,
      params.calendarId,
      params.eventId,
    );

    if (getResponse.status === 401 && !retriedAuth) {
      retriedAuth = true;
      accessToken = await deps.forceRefreshAccessToken();
      continue;
    }
    if (!getResponse.ok) {
      throw new GoogleApiError(getResponse.status, await getResponse.text());
    }

    const attendees = await parseEventAttendees(getResponse);
    const selfIndex = attendees.findIndex((attendee) => attendee.self === true);
    if (selfIndex === -1) {
      throw new NotAnAttendeeError();
    }
    const updatedAttendees: RawAttendee[] = attendees.map((attendee, index) =>
      index === selfIndex ? { ...attendee, responseStatus: params.responseStatus } : attendee,
    );

    const patchResponse = await patchAttendeesRaw(
      deps.fetch,
      accessToken,
      params.calendarId,
      params.eventId,
      updatedAttendees,
    );

    if (patchResponse.status === 401 && !retriedAuth) {
      retriedAuth = true;
      accessToken = await deps.forceRefreshAccessToken();
      continue;
    }
    if (!patchResponse.ok) {
      throw new GoogleApiError(patchResponse.status, await patchResponse.text());
    }

    return;
  }
}
