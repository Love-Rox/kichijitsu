import type { EventGuestsRequest } from "@kichijitsu/shared";
import type { RawAttendee } from "../google/rsvp-raw";

/**
 * ゲスト (参加者) の追加・削除 (2026-07-31) の純関数層。POST /api/event/guests の
 * ボディ検証と、`events.get` で読んだ attendees 配列への差分適用を持つ。
 *
 * ここが「何を全置換するか」を決める唯一の場所なので、判断はすべてこの1ファイルに集めて
 * テストで固める ―― `events.patch` の attendees は**全置換**であり、ここで組み立て損ねると
 * 予定から参加者が丸ごと消える (しかも他の全員のカレンダーからも消える)。
 */

/** 1回の要求で扱えるアドレスの件数上限。UI は1件ずつ送るが、API としての歯止めを置く */
const MAX_EMAILS_PER_REQUEST = 50;

/** メールアドレス1件の長さ上限 (RFC 5321 の実務上の上限。web 側の検査と同じ値) */
const MAX_EMAIL_LENGTH = 254;

/**
 * POST /api/event/guests のボディ検証 (create-event.ts / patch-event.ts と同じ
 * 「型ガード付き純関数」の流儀)。
 *
 * **アドレスの妥当性そのものはここで最終判定しない**: 形の検査はクライアント
 * (web の isValidGuestEmail) が行い、正しさの最終判断は Google が行う。ここで見るのは
 * 「API として受け取ってよい形か」だけ ―― 非空文字列であること、`@` を含むこと、
 * 長さと件数の上限、そして **add/remove の両方が空でないこと** (空の要求をそのまま
 * Google への events.get/patch 2往復に変えない)。
 */
export function isValidEventGuestsRequest(body: unknown): body is EventGuestsRequest {
  if (!body || typeof body !== "object") return false;
  const candidate = body as Record<string, unknown>;

  for (const key of ["accountId", "calendarId", "eventId"]) {
    const value = candidate[key];
    if (typeof value !== "string" || value.length === 0) return false;
  }

  const add = candidate.addEmails;
  const remove = candidate.removeEmails;
  if (!isValidEmailList(add) || !isValidEmailList(remove)) return false;

  const addCount = Array.isArray(add) ? add.length : 0;
  const removeCount = Array.isArray(remove) ? remove.length : 0;
  if (addCount === 0 && removeCount === 0) return false;
  if (addCount + removeCount > MAX_EMAILS_PER_REQUEST) return false;

  return true;
}

/** 未指定 (undefined) か、受け取ってよい形のメール文字列だけの配列か */
function isValidEmailList(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every(
    (item) =>
      typeof item === "string" &&
      item.length > 0 &&
      item.length <= MAX_EMAIL_LENGTH &&
      item.includes("@") &&
      !/[\s,;]/.test(item),
  );
}

/** 同一性の判定に使う正規化キー (web の guestEmailKey と同じ規則: 前後の空白を落として小文字化) */
export function guestEmailKey(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * この参加者を外してよいか。**外せない相手は要求されても残す** ―― UI 側でも押せないが、
 * ここが Google へ送る配列を決める最後の関門なので、両方で守る。
 *
 *  - `self` … 自分自身。主催者が自分を外すとその予定は自分のカレンダーから消える
 *    (予定自体は他の参加者のところに残る)。出たくないなら RSVP、無くしたいなら削除。
 *  - `organizer` … 主催者の行。主催者の変更は events.move という別の操作。
 *  - `resource` … 会議室・機材。人ではないので、この経路では扱わない。
 */
export function isRemovableGuest(attendee: RawAttendee): boolean {
  return attendee.self !== true && attendee.organizer !== true && attendee.resource !== true;
}

export interface GuestChangeResult {
  /** events.patch へ送る attendees 配列 (全置換) */
  next: RawAttendee[];
  /** 実際に足した件数。0 なら要求されたアドレスが全て既にいた */
  added: number;
  /** 実際に外した件数。0 なら要求された相手が居ない/外せない相手だった */
  removed: number;
}

/**
 * `events.get` で読んだ attendees 配列に差分を適用する。
 *
 * 守っていること:
 *  - **既存の行はオブジェクトごとそのまま持ち回す** (`RawAttendee` は未知のプロパティを
 *    透過する型)。responseStatus を含む全フィールドを保つ ―― 全置換なので、落とした
 *    フィールドはそのまま Google 上から消える。
 *  - 外せない相手 (自分・主催者・会議室) は要求されても残す (isRemovableGuest)。
 *  - 既にいるアドレスは足さない (大小無視)。同じ要求内の重複も1件に畳む。
 *  - 追加は**末尾に足す**。並びは表示側 (web の guestList.ts) が決めるので、
 *    ここで既存の順を触る必要は無い。
 *  - 追加する行は `{ email }` だけにする。responseStatus を自分で書かない ―― 公式に
 *    「accepted/tentative/declined を入れて追加すると、招待設定によっては
 *    needsAction に戻され、招待メールから返事するまで予定が現れない」旨の警告があり、
 *    Google に既定 (needsAction) を付けさせるのが最も素直で安全。
 */
export function applyGuestChanges(
  current: RawAttendee[],
  change: { addEmails?: string[]; removeEmails?: string[] },
): GuestChangeResult {
  const removeKeys = new Set((change.removeEmails ?? []).map(guestEmailKey));
  const kept: RawAttendee[] = [];
  let removed = 0;
  for (const attendee of current) {
    const email = typeof attendee.email === "string" ? attendee.email : undefined;
    if (email !== undefined && removeKeys.has(guestEmailKey(email)) && isRemovableGuest(attendee)) {
      removed += 1;
      continue;
    }
    kept.push(attendee);
  }

  const presentKeys = new Set(
    kept
      .filter((a): a is RawAttendee & { email: string } => typeof a.email === "string")
      .map((a) => guestEmailKey(a.email)),
  );
  let added = 0;
  for (const raw of change.addEmails ?? []) {
    const email = raw.trim();
    if (email.length === 0) continue;
    const key = guestEmailKey(email);
    if (presentKeys.has(key)) continue;
    presentKeys.add(key);
    kept.push({ email });
    added += 1;
  }

  return { next: kept, added, removed };
}
