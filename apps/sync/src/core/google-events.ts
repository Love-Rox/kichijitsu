import type { EventAttendeeDTO, GoogleEventDTO } from "@kichijitsu/shared";

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
   * 参加ステータス表示 (RSVP、2026-07-22) と参加者の表示 (2026-07-30) の元データ。
   * deriveSelfResponseStatus/deriveIsOrganizer が self:true のエントリだけを拾って
   * GoogleEventDTO の派生フィールドへ潰し、配列そのものは deriveAttendees が
   * **必要なフィールドだけ・上限件数まで**に絞ってから DTO へ載せる。
   */
  attendees?: RawAttendee[];
  /**
   * Google 自身が「attendees は全員ぶんではない」と宣言するフィールド (maxAttendees を
   * 指定したときに立つ)。kichijitsu は maxAttendees を付けない (buildEventsListUrl 参照)
   * ため通常は来ないが、来たときに黙って握り潰さないよう deriveAttendeesOmitted で拾う。
   */
  attendeesOmitted?: boolean;
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

/**
 * event.attendees[] の1要素のうち kichijitsu が読むフィールドだけを写した型。
 * Google は他にも id/comment/additionalGuests/optional を返すが、参加者の表示
 * (2026-07-30) に要らないため写さない ―― 詳細は EventAttendeeDTO のコメント参照。
 */
interface RawAttendee {
  email?: string;
  displayName?: string;
  self?: boolean;
  organizer?: boolean;
  resource?: boolean;
  responseStatus?: string;
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
 * DTO に載せる参加者の上限件数 (参加者の表示、2026-07-30)。
 *
 * サーバーはイベント本体を保存しない設計なので、ここで通した配列はそのまま各端末の
 * IndexedDB に積まれる ―― 大人数の予定 (全社会議など数百人) を丸ごと持つと、読みもしない
 * データでレプリカが膨らむ。詳細カードが実際に見せるのは十数人ぶんで、それを超える分は
 * どのみち「ほか N 人」に畳まれるため、50 件で足切りして attendeesOmitted を立てる。
 *
 * events.list の `maxAttendees` は**使わない**: 公式仕様が「上限を超えた場合は
 * (切り詰めるのではなく) 参加者本人1件だけを返す」と定めており、大人数の予定で
 * 一覧が丸ごと消えてしまう。切り詰めは自前でやる方が挙動が読める。
 * (加えて syncToken は取得時と同じクエリパラメータでしか使えないため、events.list の
 *  パラメータ構成は増やさないに越したことがない ―― buildEventsListUrl のコメント参照)
 */
export const MAX_DTO_ATTENDEES = 50;

/**
 * attendees[] の1件を DTO 形へ。email も displayName も無い行は画面に出しようがないので
 * null を返して落とす (Google は現在 email に必ず何かを入れて返すが、それが実在しない
 * 生成値のことがある ―― 公式の alwaysIncludeEmail の記述参照。両方欠けた行は残さない)。
 * responseStatus は deriveSelfResponseStatus と同じく、union に無い値は落として安全側へ倒す。
 */
function toAttendeeDTO(attendee: RawAttendee): EventAttendeeDTO | null {
  if (!attendee.email && !attendee.displayName) return null;
  const status =
    attendee.responseStatus && VALID_RESPONSE_STATUSES.has(attendee.responseStatus)
      ? (attendee.responseStatus as NonNullable<EventAttendeeDTO["responseStatus"]>)
      : undefined;
  return {
    ...(attendee.email ? { email: attendee.email } : {}),
    ...(attendee.displayName ? { displayName: attendee.displayName } : {}),
    ...(status ? { responseStatus: status } : {}),
    ...(attendee.self === true ? { self: true as const } : {}),
    ...(attendee.organizer === true ? { organizer: true as const } : {}),
    ...(attendee.resource === true ? { resource: true as const } : {}),
  };
}

/**
 * 参加者一覧 (GoogleEventDTO.attendees / attendeesOmitted、2026-07-30) を組み立てる。
 * 値がある分だけスプレッドできる断片を返す (web 側 mapGoogle.ts の rsvpFields と同じ流儀 ――
 * 「無ければキー自体を持たせない」)。
 *
 * 上限 (MAX_DTO_ATTENDEES) を超えたときは**自分 (self) と主催者 (organizer) を必ず残し**、
 * 残りを元の順で埋める: 詳細カードは真っ先にこの2人を出すので、切り詰めで消えると
 * 「主催者が分からない」「自分がいない」という一番困る欠け方をする。この場合だけ順序が
 * 元の attendees 順とずれるが、上限に達しない通常の予定 (ほぼ全部) では順序を保つ。
 *
 * attendeesOmitted は「手元の一覧が全員ぶんではない」ことを示す。立てるのは3通り:
 *   - Google 自身が立てて返してきた (maxAttendees 指定時。kichijitsu は指定しないので通常来ない)
 *   - MAX_DTO_ATTENDEES で切り詰めた
 *   - email も displayName も無い行を落とした
 * いずれも「人数を断定できない」点では同じなので、表示側は1つのフラグとして扱えばよい。
 */
export function deriveAttendeeList(raw: RawGoogleEvent): {
  attendees?: EventAttendeeDTO[];
  attendeesOmitted?: true;
} {
  const list = raw.attendees;
  if (!list || list.length === 0) return {};

  const mapped = list
    .map(toAttendeeDTO)
    .filter((attendee): attendee is EventAttendeeDTO => attendee !== null);
  if (mapped.length === 0) return {};

  const omitted = raw.attendeesOmitted === true || mapped.length < list.length;

  if (mapped.length <= MAX_DTO_ATTENDEES) {
    return { attendees: mapped, ...(omitted ? { attendeesOmitted: true as const } : {}) };
  }

  const keepFirst = mapped.filter((a) => a.self === true || a.organizer === true);
  const rest = mapped.filter((a) => a.self !== true && a.organizer !== true);
  return {
    attendees: [...keepFirst, ...rest].slice(0, MAX_DTO_ATTENDEES),
    attendeesOmitted: true,
  };
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
 * 3=isWorkingLocation, 4=空振り用, 5=conferenceUrl, 6=attendees) は web 側のコメントに一覧がある。
 * 現在値 6 = attendees / attendeesOmitted まで対応 (deriveAttendeeList、2026-07-30)。
 */
export const SUPPORTED_SYNC_BACKFILL_VERSION = 6;

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
    ...deriveAttendeeList(raw),
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
