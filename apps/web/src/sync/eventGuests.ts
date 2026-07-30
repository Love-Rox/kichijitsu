import type { EventAttendee, Occurrence } from "../model/types";
import { guestRemovalBlockReason } from "../layout/guestList";
import { isEditableEventSubject } from "./eventEdit";
import { rawGoogleEventId } from "./eventPatch";

/**
 * ゲスト (参加者) の追加・削除 (2026-07-31) に関する純関数群。詳細ポップオーバーの
 * ゲスト欄から呼ばれる。
 *
 * ## なぜ「主催者の単発予定だけ」なのか (この版の適用範囲)
 * 直前の版 (2026-07-30) はゲストを**表示だけ**にしてあった。編集で怖いのは
 * 「足したつもりが誰にも届いていない」状態で、これは次の2つから生まれる:
 *
 *  1. **主催者でない予定**。公式の Event propagation に
 *     「The only event change that is propagated from attendees back to the organizer is
 *     the attendee's response status」と明記されており、参加者側の複製で共有プロパティを
 *     変えても「only reflected on their own copy and might be lost if the organizer makes
 *     a change」。**しかも、参加者が attendees を patch したとき Google が 403
 *     (forbiddenForNonOrganizer) を返すのか、200 で自分の複製だけ変えるのかは公式に
 *     書かれていない** ―― 挙動が定義されていない操作を利用者に踏ませない。
 *     `guestsCanInviteOthers` (既定 true) を同期すれば「Google の UI なら足せる予定」を
 *     見分けられるが、それでも API 上の結果が不明なことは変わらないうえ、同期フィールドの
 *     追加 = バックフィル世代の引き上げ (全利用者の再全同期) を伴う。**主催者のときだけ
 *     編集可**にすれば、世代を上げずに同じ事故を確実に防げる。
 *     (捨てているもの: 自分が主催でない予定に人を足す導線。Google カレンダー側で行う)
 *  2. **繰り返し予定**。公式には「an exception may have … additional attendees invited
 *     only to that instance」とあり1回分だけ変えること自体は正規の操作だが、
 *     Occurrence は「いま表示している一覧がシリーズ由来か例外由来か」を持っていない
 *     (expandSeries が override.patch.attendees を優先して潰す) ため、**何を全置換
 *     しようとしているのかクライアントからは決められない**。この版では対象外にする。
 *
 * 最終的な可否の判断はサーバー側 (apps/sync の core/guest-event.ts) が `events.get` の
 * `organizer.self` で行う ―― ここでの判定は導線を出すかどうかの UI 判断であって、
 * 権限のチェックそのものではない。
 *
 * ## attendees の全置換について
 * `events.patch` の attendees はマージではなく**全置換**
 * (公式: "Array fields, if specified, overwrite the existing arrays; this discards any
 * previous array elements") なので、書き込みは read-modify-write が必須。ただし
 * クライアントが持つ一覧は最大50件で打ち切られていることがある (attendeesOmitted) ため、
 * **クライアントは配列そのものを送らない** ―― 「このメールを足す/外す」という差分だけを
 * 送り、read-modify-write はサーバーが `events.get` の結果に対して行う。おかげで
 * 打ち切られた予定でも、手元に無い参加者を巻き添えで消さずに編集できる。
 */

/** ゲスト欄からの1回ぶんの変更。追加と削除を同時に指定できる (両方空なら何も送らない) */
export interface GuestChange {
  addEmails?: string[];
  removeEmails?: string[];
}

/**
 * POST /api/event/guests が 422 (not_organizer) を返したことを示すエラー。
 * 「主催者でない予定のゲストは変更できません」という、ネットワーク失敗一般とは違う
 * 専用メッセージを出し分けるために、フック側 (useEventMutations の editGuests) が
 * これを throw し、UI 側 (EventDetailCard の GuestSection) が instanceof で判定する
 * (sync/eventRsvp.ts の RsvpNotAttendeeError と同じ流儀)。
 *
 * canEditGuests が false なら導線自体を出さないので通常は起きないが、
 * **手元の isOrganizer が古い**とき (主催者が Google 側で変わった直後など) に起きうる。
 */
export class GuestNotOrganizerError extends Error {
  constructor() {
    super("not_organizer");
    this.name = "GuestNotOrganizerError";
  }
}

/** parseGuestEmailInput が返す失敗理由。UI 側で日本語メッセージに変換する */
export type GuestEmailError = "empty" | "invalid" | "tooLong" | "duplicate" | "self";

/** メールアドレスの上限。RFC 5321 の実務上の上限 (全体 254 / ローカル部 64) */
const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;

/**
 * 「表示名 <アドレス>」形式から中身を取り出す。メールクライアントや連絡先アプリから
 * 貼り付けると高い確率でこの形になるので、弾くより解いてやるほうが親切
 * (山括弧が片方しか無い等の壊れた入力は、下の検査で invalid に落ちる)。
 */
function unwrapAngleBrackets(value: string): string {
  const match = /^[^<>]*<([^<>]*)>$/.exec(value);
  return match ? match[1].trim() : value;
}

/**
 * ドット区切りの各ラベルが空でないか (先頭/末尾のドット・連続ドットを弾く)。
 * `.a@b.com` `a..b@c.com` `a@b..com` のような、送信すれば確実に跳ね返るアドレスを
 * そのまま Google へ流さないための最低限の検査。
 */
function hasNonEmptyLabels(value: string): boolean {
  return value.split(".").every((label) => label.length > 0);
}

/**
 * 1件ぶんのメールアドレスの検査。**厳密な RFC 準拠は狙わない** ―― 目的は
 * 「明らかに宛先にならない文字列を Google へ送らない」ことで、正しさの最終判断は
 * Google 側が行う。ここで通してしまうと招待が飛ばないまま参加者一覧に幽霊の行が残り、
 * しかもそれが**他のゲストにもそう見える**ので、疑わしいものは弾く。
 */
export function isValidGuestEmail(value: string): boolean {
  if (value.length === 0 || value.length > MAX_EMAIL_LENGTH) return false;
  // 空白・カンマ・セミコロン・引用符・括弧を含むものは、複数アドレスの貼り付けか壊れた入力
  if (/[\s,;"<>()[\]\\]/.test(value)) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > MAX_LOCAL_LENGTH) return false;
  if (!hasNonEmptyLabels(local)) return false;
  // ドメインは必ず1つ以上のドットを含み、TLD は英字2文字以上 (`a@localhost` は招待先にならない)
  if (!domain.includes(".") || !hasNonEmptyLabels(domain)) return false;
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) return false;
  if (domain.split(".").some((label) => label.startsWith("-") || label.endsWith("-"))) return false;
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (tld.length < 2 || /[^A-Za-z]/.test(tld)) return false;
  return true;
}

/**
 * 同一性の判定に使う正規化キー。**表示や送信のためにアドレスを小文字化はしない**
 * (ローカル部の大小は原理的には別のアドレス) が、重複判定は現実に合わせて大小無視で
 * 行う ―― 同じ相手を2行に増やすほうが、まれな大小違いを別人として扱えないことより悪い。
 */
export function guestEmailKey(email: string): string {
  return email.trim().toLowerCase();
}

export type GuestEmailParseResult =
  | { ok: true; email: string }
  | { ok: false; reason: GuestEmailError };

/**
 * 入力欄の文字列 → 追加してよいメールアドレス。既存の参加者一覧を渡すと、
 * 重複 (同じ人をもう一度足す) と自分自身を弾く。
 *
 * 自分を弾くのは事故防止というより意味の問題: 主催者は既に attendees に入っており、
 * 「自分を足す」操作は Google から見ると何も起きない (が、一覧には何かが起きたように
 * 見える)。重複と同じ扱いにせず専用の理由を返して、そう言えるようにしてある。
 */
export function parseGuestEmailInput(
  raw: string,
  existing: EventAttendee[] | undefined,
): GuestEmailParseResult {
  const trimmed = unwrapAngleBrackets(raw.trim());
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length > MAX_EMAIL_LENGTH) return { ok: false, reason: "tooLong" };
  if (!isValidGuestEmail(trimmed)) return { ok: false, reason: "invalid" };

  const key = guestEmailKey(trimmed);
  const hit = existing?.find((a) => a.email !== undefined && guestEmailKey(a.email) === key);
  if (hit) return { ok: false, reason: hit.self === true ? "self" : "duplicate" };
  return { ok: true, email: trimmed };
}

/** ゲスト欄の編集導線を出す判定に必要な、Occurrence/AllDayOccurrence の共通部分だけの形 */
export interface GuestEditSubject {
  id: string;
  title: string;
  source: Occurrence["source"];
  seriesId?: string | null;
  isMirror?: boolean;
  isOrganizer?: boolean;
  accountId?: string;
  calendarId?: string;
  attendees?: EventAttendee[];
}

/**
 * ゲストの追加・削除の導線を出してよいか (モジュール冒頭の「適用範囲」参照)。
 *
 *  - 編集可能な Google 予定であること (source==='google'、mirror や Busy でない)
 *  - **自分が主催**であること (isOrganizer===true)
 *  - **繰り返しシリーズ由来でない**こと (seriesId が null/undefined)
 *  - accountId/calendarId が揃っていて、id から event id を取り出せること
 *
 * false のときはゲスト欄を従来どおり表示のみで出す ―― 「できません」と書いた
 * 押せないボタンは置かない (押せる場所にあって押せないのが一番わかりにくい)。
 */
export function canEditGuests(subject: GuestEditSubject): boolean {
  if (!isEditableEventSubject(subject)) return false;
  if (subject.isOrganizer !== true) return false;
  if (subject.seriesId) return false;
  if (!subject.accountId || !subject.calendarId) return false;
  try {
    rawGoogleEventId(subject.id);
    return true;
  } catch {
    return false;
  }
}

/** POST /api/event/guests の body (protocol.ts の EventGuestsRequest と同じ形) */
export interface BuiltGuestsRequest {
  accountId: string;
  calendarId: string;
  eventId: string;
  addEmails?: string[];
  removeEmails?: string[];
}

/**
 * subject + 変更内容から POST /api/event/guests の body を組み立てる。
 * canEditGuests が false な相手・id のパースに失敗した相手・変更が空のときは null
 * (buildEventRsvpRequest / buildScopedEventPatchRequest と同じ流儀)。
 */
export function buildEventGuestsRequest(
  subject: GuestEditSubject,
  change: GuestChange,
): BuiltGuestsRequest | null {
  if (!canEditGuests(subject)) return null;
  const addEmails = (change.addEmails ?? []).filter((e) => e.length > 0);
  const removeEmails = (change.removeEmails ?? []).filter((e) => e.length > 0);
  if (addEmails.length === 0 && removeEmails.length === 0) return null;
  try {
    return {
      accountId: subject.accountId!,
      calendarId: subject.calendarId!,
      eventId: rawGoogleEventId(subject.id),
      ...(addEmails.length > 0 ? { addEmails } : {}),
      ...(removeEmails.length > 0 ? { removeEmails } : {}),
    };
  } catch (err) {
    console.error("kichijitsu: failed to build EventGuestsRequest", err);
    return null;
  }
}

/**
 * 楽観表示用の attendees。**サーバーが行う read-modify-write の予測**であって正本ではない
 * ―― 次の同期 (webhook → SSE → /api/sync) で Google の結果に置き換わる。
 *
 * 追加した行は `responseStatus: "needsAction"` (未返信) にする: Google が招待直後の
 * 参加者に付ける値そのもので、一覧の見え方が同期後と変わらない。displayName は
 * 分からないので付けない (guestList.ts がメールを主表示に落とす)。
 *
 * 外せない行 (自分・主催者・会議室) は要求されても残す。UI 側でも押せないが、
 * ここが一覧の見た目を決める最後の関門なので、両方で守っておく。
 */
export function applyGuestChangesLocally(
  attendees: EventAttendee[] | undefined,
  change: GuestChange,
): EventAttendee[] {
  const removeKeys = new Set((change.removeEmails ?? []).map(guestEmailKey));
  const kept = (attendees ?? []).filter((a) => {
    if (a.email === undefined) return true;
    if (!removeKeys.has(guestEmailKey(a.email))) return true;
    return guestRemovalBlockReason(a) !== null;
  });
  const presentKeys = new Set(
    kept.filter((a) => a.email !== undefined).map((a) => guestEmailKey(a.email!)),
  );
  const added: EventAttendee[] = [];
  for (const email of change.addEmails ?? []) {
    const key = guestEmailKey(email);
    if (presentKeys.has(key)) continue;
    presentKeys.add(key);
    added.push({ email, responseStatus: "needsAction" });
  }
  return [...kept, ...added];
}
