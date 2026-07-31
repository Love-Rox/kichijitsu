import { GoogleApiError } from "./errors";
import { getEventRaw, type RawAttendee } from "../google/rsvp-raw";

/**
 * `attendees` 配列の read-modify-write の骨組み (2026-07-31 に共通化)。
 *
 * Google Calendar API の `events.patch` は **attendees を全置換**する (マージではない) ため、
 * 参加者に関わる書き込みは必ず「events.get で全員読む → 配列を組み直す → events.patch」の
 * 3段になる。この骨組みを使う経路は2つあり、
 *
 *  - RSVP (core/rsvp-event.ts) ―― self の responseStatus だけ差し替える
 *  - ゲストの追加・削除 (core/guest-event.ts) ―― 差分を当てる
 *
 * **違うのは真ん中の1段だけ**で、deps の形・GET の 401 リトライ・PATCH の 401 リトライ・
 * エラー変換は行単位で同じものが2つ並んでいた。とくに「401 でどこからやり直すか」は
 * 間違えても普段は表に出ず、片方だけ直される類の場所なので、骨組みはここ1つにする。
 */
export interface AttendeeWriteDeps {
  fetch: typeof fetch;
  /** キャッシュがあれば使い、無ければ (または期限切れなら) refresh_token から取り直す。 */
  getAccessToken: () => Promise<string>;
  /** キャッシュを無視して強制的にリフレッシュする (401 リトライ用)。 */
  forceRefreshAccessToken: () => Promise<string>;
}

/**
 * attendees 全置換の PATCH を投げる google 層の関数
 * (rsvp-raw.ts の patchAttendeesRaw / guests-raw.ts の patchGuestsRaw)。
 *
 * **どちらを使うかは呼び出し元に選ばせる**: 送るリクエストは同じでも、`sendUpdates=all` に
 * する根拠が経路ごとに違い (RSVP は「応答を伝える行為そのもの」、ゲスト編集は「招待が
 * 届かないと足したつもりが誰にも届かない」)、その説明は各関数の側に置いてある。
 */
export type PatchAttendeesFn = (
  fetchFn: typeof fetch,
  accessToken: string,
  calendarId: string,
  eventId: string,
  attendees: RawAttendee[],
) => Promise<Response>;

export interface AttendeeWriteSteps {
  patchAttendees: PatchAttendeesFn;
  /**
   * `events.get` の応答から、書き戻す attendees 配列を決める。
   *
   * - `null` を返すと **patch を送らずに成功として返る** (何も変わらない patch でゲスト全員の
   *   受信箱を鳴らさないため ―― この経路の patch は sendUpdates=all)。
   * - 書き込んではいけない相手だった場合は、この中で NotAnAttendeeError / NotOrganizerError を
   *   投げる (route 側が 422 に変換する)。**エラー型が経路ごとに違うので、判定はここに残す**。
   */
  resolveNext: (response: Response) => Promise<RawAttendee[] | null>;
}

/**
 * events.get → resolveNext → events.patch を、401 リトライ込みで実行する。
 *
 * 401 リトライは他の *WithRetry (core/patch-event.ts 等) と同じく「1回だけ強制リフレッシュ
 * して再試行」の方針だが、ここでは **GET/PATCH の2段構成全体を1つの試行単位**として扱う ――
 * どちらの呼び出しで 401 が出ても、まだリトライしていなければ forceRefreshAccessToken して
 * から GET からやり直す (2回目の試行では改めて 401 が出ても即座に GoogleApiError として
 * 伝播させ、無限ループしない)。GET→PATCH の間で attendees が変わっている可能性 (競合) は
 * あるが、events.patch に楽観ロック (ETag/If-Match) 相当を使っていない現状ではこれ以上の
 * ことはできない ―― 他の書き込み系 RPC と同じ楽観前提。
 */
export async function updateAttendeesWithRetry(
  deps: AttendeeWriteDeps,
  params: { calendarId: string; eventId: string },
  steps: AttendeeWriteSteps,
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

    const next = await steps.resolveNext(getResponse);
    if (next === null) {
      return;
    }

    const patchResponse = await steps.patchAttendees(
      deps.fetch,
      accessToken,
      params.calendarId,
      params.eventId,
      next,
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
