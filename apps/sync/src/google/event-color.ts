const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";

export interface PatchEventColorParams {
  calendarId: string;
  eventId: string;
  /** Google のイベント色 "1".."11"。空文字は、予定個別の色を外す(Google には null を送る)。 */
  colorId: string;
}

/**
 * `events.patch` で colorId だけを書き換える。他のフィールドは body に含めないので Google 側の値は
 * そのまま保たれる。空文字は null にして送る(Google の patch は null でフィールドを削除する)。
 *
 * `sendUpdates=none`: 色は、見た目だけの属性で、ゲストの予定の中身(時刻・タイトル・参加者)を何も
 * 変えない。メールを出す理由が無いので、通知しない。時刻やタイトルの変更では none を使わない
 * (外部ゲストのカレンダーだけが古いまま残るため、core/patch-event.ts)。この関数は colorId 専用。
 * 呼び出し元 (core/event-color.ts) が status を見て 401 リトライとエラー変換を行うため、response を
 * そのまま返し throw しない(他の google/*.ts と同じ層分担)。
 */
export async function patchEventColor(
  fetchFn: typeof fetch,
  accessToken: string,
  params: PatchEventColorParams,
): Promise<Response> {
  const url = `${CALENDAR_BASE}/${encodeURIComponent(params.calendarId)}/events/${encodeURIComponent(params.eventId)}?sendUpdates=none`;
  return fetchFn(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ colorId: params.colorId === "" ? null : params.colorId }),
  });
}
