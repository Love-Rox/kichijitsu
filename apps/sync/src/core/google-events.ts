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
   * 有無の判定 (deriveHasConference) と参加 URL の抽出 (deriveConferenceUrl) の両方で使う。
   * Google 側のフィールド構成はバリエーションが多いため、kichijitsu が実際に読む部分
   * (entryPoints[].entryPointType / uri) だけを RawConferenceData として型付けし、
   * それ以外は写さない ―― 実際の値の絞り込みは deriveConferenceUrl 側のランタイム検査で行う
   * (この型は JSON.parse の結果に被せただけの「期待する形」であり、保証ではない)。
   */
  conferenceData?: RawConferenceData;
  hangoutLink?: string;
}

/**
 * conferenceData のうち kichijitsu が読むフィールドだけを写した型 (会議参加 URL、2026-07-25)。
 * Meet は entryPointType==='video' の uri に Meet URL が入り、カレンダーのアドオン
 * (Zoom/Teams 等) も同じ entryPoints の形で URL を載せてくる。電話参加は
 * entryPointType==='phone' + uri='tel:+81...' の形で混在するため、値の採否は
 * deriveConferenceUrl が判定する。
 */
interface RawConferenceData {
  entryPoints?: { entryPointType?: string; uri?: string }[];
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

/** 参加 URL として採用してよいスキームか (http/https のみ。tel: の電話エントリ等は除外) */
const HTTP_URL_PATTERN = /^https?:\/\//i;

/** conferenceData から entryPoints 配列だけを安全に取り出す (形が違えば空配列) */
function readEntryPoints(conferenceData: unknown): unknown[] {
  if (typeof conferenceData !== "object" || conferenceData === null) return [];
  if (!("entryPoints" in conferenceData)) return [];
  const entryPoints = conferenceData.entryPoints;
  return Array.isArray(entryPoints) ? entryPoints : [];
}

/**
 * entryPoints の1要素から参加 URL を取り出す。requiredType を渡した場合は
 * entryPointType が一致する要素だけを採用する。uri が http/https で始まらない
 * (tel: 等) 場合や、そもそも文字列でない場合は undefined。
 */
function entryPointUri(entry: unknown, requiredType?: string): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  if (requiredType !== undefined) {
    const entryPointType = "entryPointType" in entry ? entry.entryPointType : undefined;
    if (entryPointType !== requiredType) return undefined;
  }
  const uri = "uri" in entry ? entry.uri : undefined;
  if (typeof uri !== "string" || !HTTP_URL_PATTERN.test(uri)) return undefined;
  return uri;
}

/**
 * 会議への参加 URL (GoogleEventDTO.conferenceUrl、2026-07-25)。
 *
 * 背景: Slack ハドルは location に URL がそのまま入るのでクライアント側だけで参加リンクを
 * 出せるが、Google Meet とカレンダーのアドオン経由の Zoom/Teams は URL が location ではなく
 * conferenceData.entryPoints[].uri / hangoutLink に入る。有無 (deriveHasConference) だけでは
 * 「○○で参加」リンクを出せないため、URL 自体を1つだけ DTO へ持ち出す。
 *
 * 優先順位:
 *   1. entryPoints のうち entryPointType==='video' のもの (Meet/Zoom/Teams いずれもここに入る)
 *   2. entryPoints のうち採用可能な最初のもの (entryPointType が未知/欠落の新種アドオン向け)
 *   3. hangoutLink (古い Hangouts 由来のイベントは conferenceData を持たないことがある)
 *
 * 採用するのは http/https で始まる uri のみ ―― 電話参加 (tel:+81...) や sip: を
 * 「参加リンク」として出すと誤誘導になるため除外する。該当が無ければ undefined
 * (hasConference が true でも conferenceUrl は undefined になり得る = 電話のみの会議や、
 * Google が稀に返す空の conferenceData)。
 *
 * unknown で受けるのは、この値が Google API の生 JSON 由来で形が保証されないため
 * (RawGoogleEvent.conferenceData の型は「期待する形」に過ぎない)。絞り込みは全て
 * ランタイム検査で行う。
 */
export function deriveConferenceUrl(
  conferenceData: unknown,
  hangoutLink: string | undefined,
): string | undefined {
  const entryPoints = readEntryPoints(conferenceData);
  for (const entry of entryPoints) {
    const uri = entryPointUri(entry, "video");
    if (uri) return uri;
  }
  for (const entry of entryPoints) {
    const uri = entryPointUri(entry);
    if (uri) return uri;
  }
  if (typeof hangoutLink === "string" && HTTP_URL_PATTERN.test(hangoutLink)) return hangoutLink;
  return undefined;
}

interface RawEventsListResponse {
  items: RawGoogleEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

/**
 * このビルドの sync が **GoogleEventDTO に載せられるフィールドの世代** (同期バックフィル世代、
 * 2026-07-25)。GET /api/me が MeResponse.syncBackfillVersion として返し、web は
 * min(自分の CURRENT_SYNC_BACKFILL_VERSION, この値) までしかバックフィル完了として記録しない
 * (理由は shared の protocol.ts の MeResponse.syncBackfillVersion のコメント参照 — web だけ先に
 * デプロイされた状態で「サーバーがまだ返さないフィールド」をバックフィル済みと記録してしまう事故の
 * 恒久対策)。
 *
 * ここに置いてあるのは、この数字の意味が「toGoogleEventDTO (下) が何を載せられるか」そのものだから。
 * **サーバー側の DTO に新しいフィールドを足したときは、web の CURRENT_SYNC_BACKFILL_VERSION
 * (apps/web/src/db/database.ts) と一緒にこの値も上げる**。世代の意味 (1=eventType, 2=RSVP,
 * 3=isWorkingLocation, 4=空振り用, 5=conferenceUrl) は web 側のコメントに一覧がある。
 * 現在値 5 = conferenceUrl まで対応 (deriveConferenceUrl、2026-07-25)。
 */
export const SUPPORTED_SYNC_BACKFILL_VERSION = 5;

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
    conferenceUrl: deriveConferenceUrl(raw.conferenceData, raw.hangoutLink),
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
