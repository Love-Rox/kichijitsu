/**
 * リクエストボディ検証の共通部品 (2026-07-31)。
 *
 * ここに集めた理由: create/patch/delete/guests の各検証関数が、同じ述語と同じ上限を
 * **逐語コピーで持っていた** ―― 片方だけ直された日に「同じ 1024 のはずが実は違う」
 * という壊れ方をする。判断の中身 (どのフィールドを見るか) は各 core/*.ts に残し、
 * **述語と上限だけ**をこの1ファイルに集める。
 */

/**
 * 予定のタイトル (Google では `summary`) と場所の上限。
 *
 * **`title` と `summary` は同じ Google のフィールド**なので値も1つにする ――
 * create 側は API の入り口で `title`、patch 側は `summary` という名前でクライアントから
 * 受けるが、送り先はどちらも events の `summary` であり、別々の上限を持つ理由が無い
 * (以前は MAX_TITLE_LENGTH / MAX_SUMMARY_LENGTH という2つの名前で同じ 1024 を持っていた)。
 *
 * Google Calendar API は summary/location の上限を明記していないため、UI の1行入力として
 * 現実的な 1024 文字で切る (無制限に受けて Google 側で 400 になるより、こちらで理由の
 * 分かる 400 を返す)。
 */
export const MAX_SUMMARY_LENGTH = 1024;
export const MAX_LOCATION_LENGTH = 1024;

/** description の上限。こちらは Google Calendar API に明記された上限 8192 文字に合わせる。 */
export const MAX_DESCRIPTION_LENGTH = 8192;

/** 非空文字列か (accountId/calendarId/eventId/timeZone 用。block-rules.ts の isValidCalendarRef と同じ流儀) */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * 未指定 (undefined) か、maxLength 以内の文字列か。
 * **空文字は通す** ―― patch では「クリア」の意図を持つ値だから (core/patch-event.ts 参照)。
 */
export function isOptionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= maxLength);
}
