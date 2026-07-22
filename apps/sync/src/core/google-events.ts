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
  /** カレンダーブロック機能 (docs/blocking.md) の mirror 判定 (kichijitsuMirror) に必要。 */
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
  /** 不在レール表示 (2026-07-22) が使う。Google の生文字列をそのまま写す。 */
  eventType?: "default" | "outOfOffice" | "focusTime" | "workingLocation" | "birthday";
  /**
   * 参加ステータス表示 (RSVP、2026-07-22) の元データ。deriveSelfResponseStatus/
   * deriveIsOrganizer が self:true のエントリだけを拾って GoogleEventDTO の派生フィールドへ
   * 潰し、この生配列自体は toGoogleEventDTO の戻り値には含めない (email は self エントリの
   * 特定にのみ使い、DTO には渡さない ―― リーン維持)。
   */
  attendees?: { email?: string; self?: boolean; responseStatus?: string }[];
  /** deriveIsOrganizer が self のみを見て isOrganizer を導出する。 */
  organizer?: { self?: boolean };
  /**
   * 存在するかどうかだけを見る (deriveHasConference)。中身のフィールド構成は Google 側で
   * バリエーションが多く、かつ kichijitsu 側では使わないため型を絞らず unknown で受ける。
   */
  conferenceData?: unknown;
  hangoutLink?: string;
}

/** GoogleEventDTO.selfResponseStatus が取り得る値。Google の生文字列との照合に使う */
const VALID_RESPONSE_STATUSES = new Set(["accepted", "declined", "tentative", "needsAction"]);

/**
 * event.attendees[] のうち self:true のエントリの responseStatus を取り出す。
 * - attendees が無い(自分だけの予定・招待者がいない予定)→ undefined
 * - self:true のエントリが無い(取得できたが自分の応答行が欠けている異常系)→ undefined
 * - responseStatus が Google 側の想定外の値 → undefined に丸める(GoogleEventDTO の union を
 *   逸脱した値をクライアントへ渡さないためのガード。実際には Google API がこの4値以外を
 *   返すことは無いはずだが、将来の値追加に対して黙って通さず安全側に倒す)
 */
export function deriveSelfResponseStatus(
  attendees: RawGoogleEvent["attendees"],
): GoogleEventDTO["selfResponseStatus"] {
  const self = attendees?.find((a) => a.self === true);
  if (!self?.responseStatus || !VALID_RESPONSE_STATUSES.has(self.responseStatus)) {
    return undefined;
  }
  return self.responseStatus as GoogleEventDTO["selfResponseStatus"];
}

/** event.organizer.self===true のときのみ true。それ以外(false/organizer 自体が無い)は undefined */
export function deriveIsOrganizer(organizer: RawGoogleEvent["organizer"]): true | undefined {
  return organizer?.self === true ? true : undefined;
}

/**
 * 会議リンク (conferenceData または hangoutLink) の有無。存在判定のみで、値そのものは
 * DTO へ持ち出さない(GoogleEventDTO.hasConference のコメント参照 ―― Google API は
 * 「自分がオンライン/現地のどちらで参加するか」を公開していないため、イベント側の
 * 手段の有無で近似する設計)。conferenceData は空オブジェクト {} でも「会議リンクの枠がある」
 * とみなし true にする(Google は作成失敗時など稀に空の conferenceData を返すことがあるが、
 * それを厳密に弾く実益は薄く、hangoutLink 側で大半のケースはカバーされるため単純化する)。
 */
export function deriveHasConference(
  conferenceData: unknown,
  hangoutLink: string | undefined,
): true | undefined {
  return conferenceData !== undefined || !!hangoutLink ? true : undefined;
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
    extendedProperties: raw.extendedProperties,
    eventType: raw.eventType,
    selfResponseStatus: deriveSelfResponseStatus(raw.attendees),
    isOrganizer: deriveIsOrganizer(raw.organizer),
    hasConference: deriveHasConference(raw.conferenceData, raw.hangoutLink),
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
