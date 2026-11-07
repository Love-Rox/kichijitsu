import { GoogleApiError, SplitUnsupportedError } from "./errors";
import type { AttendeeWriteDeps } from "./attendee-write";
import {
  planFollowingSplit,
  type RawSeriesEvent,
} from "./guest-following-plan";
import {
  deleteSeriesRaw,
  insertSeriesRaw,
  listSeriesEventsRaw,
  patchRecurrenceRaw,
} from "../google/series-split-raw";
import { getEventRaw } from "../google/rsvp-raw";

export type GuestFollowingDeps = AttendeeWriteDeps;

export interface EditGuestsFollowingParams {
  calendarId: string;
  /** 対象の回のインスタンス id (`<親の id>_<開始>`) */
  eventId: string;
  addEmails?: string[];
  removeEmails?: string[];
}

export interface EditGuestsFollowingResult {
  /** 何も変わらなかった (既にそうなっていた) ので書き込まなかった */
  noop: boolean;
  newEventId?: string;
  /** Meet の会議情報を新シリーズへ写せず、Meet 無しで作った */
  meetDropped: boolean;
}

/**
 * 「これ以降」でゲストを変える。シリーズを2つに割り、新しい側にだけ変更を反映する
 * (計画は core/guest-following-plan.ts)。
 *
 * ## 書き込みの順序と失敗時の扱い
 *  1. **先に新シリーズを作る** (events.insert)。ここで失敗しても元は無傷。
 *  2. 次に親を打ち切る (events.patch)。これが失敗したら、**作った新シリーズを消して元に戻す**。
 *     (逆順だと、打ち切った後に作成が失敗して、以降の回が消えたままになる)
 * 2→ の巻き戻し自体が失敗した場合は、元のエラーを投げる。このとき予定が二重になりうるが、
 * 黙って成功にはしない (呼び出し側の UI が失敗として扱い、利用者が気付ける)。
 *
 * 401 は 1回だけ強制リフレッシュして、その呼び出しをやり直す (他の *WithRetry と同じ方針)。
 */
export async function editGuestsFollowingWithRetry(
  deps: GuestFollowingDeps,
  params: EditGuestsFollowingParams,
): Promise<EditGuestsFollowingResult> {
  let accessToken = await deps.getAccessToken();
  let retriedAuth = false;

  async function call(make: (token: string) => Promise<Response>): Promise<Response> {
    let response = await make(accessToken);
    if (response.status === 401 && !retriedAuth) {
      retriedAuth = true;
      accessToken = await deps.forceRefreshAccessToken();
      response = await make(accessToken);
    }
    return response;
  }

  async function readJson<T>(response: Response): Promise<T> {
    if (!response.ok) throw new GoogleApiError(response.status, await response.text());
    return (await response.json()) as T;
  }

  const instance = await readJson<RawSeriesEvent>(
    await call((t) => getEventRaw(deps.fetch, t, params.calendarId, params.eventId)),
  );
  if (!instance.recurringEventId) {
    throw new SplitUnsupportedError("not_recurring");
  }
  const masterId = instance.recurringEventId;
  const master = await readJson<RawSeriesEvent>(
    await call((t) => getEventRaw(deps.fetch, t, params.calendarId, masterId)),
  );
  if (!master.iCalUID) {
    throw new SplitUnsupportedError("not_recurring");
  }

  const iCalUID = master.iCalUID;
  const listed = await readJson<{ items?: RawSeriesEvent[]; nextPageToken?: string }>(
    await call((t) => listSeriesEventsRaw(deps.fetch, t, params.calendarId, iCalUID)),
  );
  if (listed.nextPageToken) {
    // 例外が1ページに収まらない = 個別に変更/削除した回が非常に多い。安全に判断できない
    throw new SplitUnsupportedError("has_future_exceptions");
  }
  const exceptions = (listed.items ?? []).filter(
    (e) => e.id !== masterId && e.recurringEventId === masterId,
  );

  const plan = planFollowingSplit({
    instance,
    master,
    exceptions,
    change: { addEmails: params.addEmails, removeEmails: params.removeEmails },
  });
  if (!plan.ok) {
    if (plan.reason === "no_change") return { noop: true, meetDropped: false };
    throw new SplitUnsupportedError(plan.reason);
  }

  // ---- 1. 新シリーズを作る (Meet の会議情報を写せなければ、Meet 無しでやり直す) ----
  let meetDropped = false;
  let insertResponse = await call((t) =>
    insertSeriesRaw(deps.fetch, t, params.calendarId, plan.newEventBody),
  );
  if (!insertResponse.ok && plan.copiesConference && insertResponse.status === 400) {
    const { conferenceData: _dropped, ...withoutConference } = plan.newEventBody;
    insertResponse = await call((t) =>
      insertSeriesRaw(deps.fetch, t, params.calendarId, withoutConference),
    );
    meetDropped = insertResponse.ok;
  }
  const created = await readJson<{ id?: string }>(insertResponse);
  const newEventId = created.id;
  if (!newEventId) {
    throw new GoogleApiError(502, "events.insert returned no id");
  }

  // ---- 2. 親を打ち切る。失敗したら新シリーズを消して元に戻す ----
  const patchResponse = await call((t) =>
    patchRecurrenceRaw(deps.fetch, t, params.calendarId, masterId, plan.truncatedRecurrence),
  );
  if (!patchResponse.ok) {
    const failure = new GoogleApiError(patchResponse.status, await patchResponse.text());
    try {
      await call((t) => deleteSeriesRaw(deps.fetch, t, params.calendarId, newEventId));
    } catch (rollbackError) {
      console.error("kichijitsu: rollback of split series failed", rollbackError);
    }
    throw failure;
  }

  return { noop: false, newEventId, meetDropped };
}
