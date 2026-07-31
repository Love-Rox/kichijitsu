import { Temporal } from "@js-temporal/polyfill";
import type { EventPatchRequest } from "@kichijitsu/shared";
import type { EventSeries } from "../model/series";
import type { AllDayOccurrence, Occurrence, OccurrenceSource } from "../model/types";
import { isBusyPlaceholder } from "../layout/gridMetrics";
import type { GuestNotify } from "./guestNotify";
import {
  buildScopedEventPatchRequest,
  DEFAULT_RECURRENCE_SCOPE,
  type RecurrenceScope,
} from "./recurrenceScope";

/**
 * 予定の編集フォーム(フェーズ2、2026-07-22)に関する純関数群。詳細ポップオーバー
 * (EventBlock.tsx の EventDetailCard)に組み込む編集モードが、Occurrence(時刻予定)/
 * AllDayOccurrence(終日予定)のどちらが元でも同じフォーム・同じ保存経路で扱えるように、
 * 「draft」という共通の中間表現(常に epoch ms で時刻を持つ)へ正規化する。
 *
 * 終日⇔時刻の変換は Google の `end.date` が排他的 (7/20〜7/21 は実質 7/20 の1日のみ)
 * であることに合わせ、draft.endMs も常に「排他的な終了(次の瞬間)」として持つ
 * ―― mapGoogle.ts の buildAllDay / apps/sync の toDateOnly と同じ規約(コメント参照)。
 */

/** 編集フォームの draft。isAllDay 以外はテキスト欄で、isAllDay の切り替えで startMs/endMs の解釈が変わる */
export interface EventEditDraft {
  title: string;
  location: string;
  description: string;
  isAllDay: boolean;
  /** 時刻予定はそのまま開始時刻。終日予定は開始日のローカル 0:00 */
  startMs: number;
  /**
   * 時刻予定はそのまま終了時刻。終日予定は「終了日(inclusive)の翌日のローカル 0:00」
   * (Google の end.date と同じ排他的表現。表示用の inclusive な終了日は
   * msExclusiveToDateValue で導出する)。
   */
  endMs: number;
}

/** 時刻予定 (Occurrence) → draft。isAllDay は常に false */
export function draftFromOccurrence(occ: Occurrence): EventEditDraft {
  return {
    title: occ.title,
    location: occ.location ?? "",
    description: occ.description ?? "",
    isAllDay: false,
    startMs: occ.startMs,
    endMs: occ.endMs,
  };
}

/**
 * 終日予定 (AllDayOccurrence) → draft。startDate/endDate (inclusive、YYYY-MM-DD) を
 * timeZone のローカル壁時計の epoch ms に変換する。endMs は endDate の「翌日」の
 * ローカル 0:00 (排他的) にする ―― サーバー (google/patch-event.ts の toDateOnly) が
 * この endMs をそのまま date に変換したとき、Google の end.date (排他的) と一致するように。
 */
export function draftFromAllDayOccurrence(occ: AllDayOccurrence, timeZone: string): EventEditDraft {
  const startMs = Temporal.PlainDate.from(occ.startDate).toZonedDateTime(
    timeZone,
  ).epochMilliseconds;
  const endMs = Temporal.PlainDate.from(occ.endDate)
    .add({ days: 1 })
    .toZonedDateTime(timeZone).epochMilliseconds;
  return {
    title: occ.title,
    location: occ.location ?? "",
    description: occ.description ?? "",
    isAllDay: true,
    startMs,
    endMs,
  };
}

/** 最低限のバリデーション: タイトル空不可・終了は開始より後(全日はendMsが排他的なので同じ不等号で足りる) */
export function validateEventEditDraft(draft: EventEditDraft): string | null {
  if (draft.title.trim() === "") return "タイトルを入力してください";
  if (draft.endMs <= draft.startMs) return "終了日時は開始日時より後にしてください";
  return null;
}

/**
 * 編集対象として「保存ボタン」導線を出してよいか。対象は自分が編集可能な Google 予定
 * (source==='google')のみ ―― カレンダーブロック機能の自動生成 mirror や、Google の
 * Busy/「予定あり」プレースホルダは中身が無い/自動管理のため編集不可とする
 * (削除導線 (EventBlock.tsx の onDelete) が source==='google' のみを対象にしているのと
 * 同じ考え方に、isMirror/isBusyPlaceholder の除外を足したもの)。
 * Occurrence/AllDayOccurrence どちらでも使えるよう、必要なフィールドだけの構造的な型で受ける。
 */
export function isEditableEventSubject(subject: {
  source: OccurrenceSource;
  title: string;
  isMirror?: boolean;
}): boolean {
  return (
    subject.source === "google" && subject.isMirror !== true && !isBusyPlaceholder(subject.title)
  );
}

/**
 * 編集フォームを開いたときの subject の時間帯 (= 変更前)。「すべての予定」に写す差分は
 * draft との差で決まる (sync/recurrenceScope.ts の seriesShiftFor 参照) ため、
 * 終日 (AllDayOccurrence) も含めて epoch ms の形に揃えて取り出す。
 * 終日予定はシリーズ由来になり得ない (展開結果は常に時刻予定) ので、実際に使われるのは
 * 時刻予定の枝だけだが、呼び出し側で分岐を書かなくて済むよう両方扱う。
 */
export function subjectTimeRange(
  subject: Occurrence | AllDayOccurrence,
  timeZone: string,
): { startMs: number; endMs: number } {
  if ("startMs" in subject) return { startMs: subject.startMs, endMs: subject.endMs };
  const { startMs, endMs } = draftFromAllDayOccurrence(subject, timeZone);
  return { startMs, endMs };
}

/**
 * draft から POST /api/event/patch の body を組み立てる。宛先 (どの event id を、どの時刻で
 * patch するか) は sync/recurrenceScope.ts の buildScopedEventPatchRequest に一本化してあり、
 * ドラッグ確定 (useEventMutations の persist) と同じ判断を通る
 * (2026-07-30、繰り返し予定の適用範囲)。scope を省略すれば従来どおり「この予定のみ」。
 * isEditableEventSubject が false な相手には呼ばない前提だが、source/accountId/calendarId の
 * ガードは buildScopedEventPatchRequest 側が持つ。
 */
export function buildEventEditPatchRequest(
  subject: Occurrence | AllDayOccurrence,
  draft: EventEditDraft,
  timeZone: string,
  scope: RecurrenceScope = DEFAULT_RECURRENCE_SCOPE,
  /** scope==='all' のときだけ必要な、ローカルの series レコード */
  series?: EventSeries | null,
  /**
   * 確認ダイアログで選ばれたゲストへの通知 (2026-07-31)。訊いていない場合は省略でよい
   * ―― buildScopedEventPatchRequest が subject を見て安全側 (externalOnly) に確定する。
   */
  notify?: GuestNotify,
): EventPatchRequest | null {
  return buildScopedEventPatchRequest({
    subject,
    scope,
    series,
    previous: subjectTimeRange(subject, timeZone),
    next: { startMs: draft.startMs, endMs: draft.endMs },
    timeZone,
    notify,
    fields: {
      summary: draft.title,
      location: draft.location,
      description: draft.description,
      isAllDay: draft.isAllDay,
    },
  });
}

/** original (Occurrence/AllDayOccurrence どちらでも) + draft(時刻予定側) → 更新後の Occurrence */
export function applyDraftToOccurrence(
  original: Occurrence | AllDayOccurrence,
  draft: EventEditDraft,
): Occurrence {
  const {
    id,
    color,
    hasCustomColor,
    source,
    link,
    accountId,
    calendarId,
    iCalUID,
    isMirror,
    isOutOfOffice,
    responseStatus,
    isOrganizer,
    hasConference,
    conferenceUrl,
    isWorkingLocation,
  } = original;
  const originalStartMs = "originalStartMs" in original ? original.originalStartMs : undefined;
  return {
    id,
    // seriesId は Occurrence/AllDayOccurrence どちらの型にも存在する共通フィールド
    seriesId: original.seriesId,
    title: draft.title,
    startMs: draft.startMs,
    endMs: draft.endMs,
    color,
    hasCustomColor,
    source,
    link,
    accountId,
    calendarId,
    iCalUID,
    location: draft.location || undefined,
    description: draft.description || undefined,
    isMirror,
    isOutOfOffice,
    responseStatus,
    isOrganizer,
    hasConference,
    conferenceUrl,
    isWorkingLocation,
    ...(originalStartMs !== undefined ? { originalStartMs } : {}),
  };
}

/**
 * original (Occurrence/AllDayOccurrence どちらでも) + draft(終日側) → 更新後の AllDayOccurrence。
 * draft.endMs (排他的) から表示用の inclusive な endDate を導出する
 * (mapGoogle.ts の buildAllDay と同じ「1日前倒し」規則、異常値のクランプも揃える)。
 */
export function applyDraftToAllDayOccurrence(
  original: Occurrence | AllDayOccurrence,
  draft: EventEditDraft,
  timeZone: string,
): AllDayOccurrence {
  const startDate = msToDateValue(draft.startMs, timeZone);
  const endDateExclusive = msToDateValue(draft.endMs, timeZone);
  let endDate = Temporal.PlainDate.from(endDateExclusive).subtract({ days: 1 }).toString();
  if (Temporal.PlainDate.compare(endDate, startDate) < 0) endDate = startDate;

  const {
    id,
    color,
    hasCustomColor,
    source,
    link,
    accountId,
    calendarId,
    iCalUID,
    isMirror,
    isOutOfOffice,
    responseStatus,
    isOrganizer,
    hasConference,
    conferenceUrl,
    isWorkingLocation,
  } = original;
  return {
    id,
    seriesId: null,
    title: draft.title,
    startDate,
    endDate,
    color,
    hasCustomColor,
    source,
    link,
    accountId,
    calendarId,
    iCalUID,
    location: draft.location || undefined,
    description: draft.description || undefined,
    isMirror,
    isOutOfOffice,
    responseStatus,
    isOrganizer,
    hasConference,
    conferenceUrl,
    isWorkingLocation,
  };
}

// ---- <input> の value ⇔ epoch ms 変換 (EventEditForm.tsx から使う純関数) ----

/** epoch ms → <input type="datetime-local"> の value ("YYYY-MM-DDTHH:mm"、分精度、timeZone のローカル壁時計) */
export function msToDatetimeLocalValue(ms: number, timeZone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(timeZone)
    .toPlainDateTime()
    .toString({ smallestUnit: "minute" });
}

/** <input type="datetime-local"> の value → epoch ms (timeZone のローカル壁時計として解釈) */
export function datetimeLocalValueToMs(value: string, timeZone: string): number {
  return Temporal.PlainDateTime.from(value).toZonedDateTime(timeZone).epochMilliseconds;
}

/** epoch ms → <input type="date"> の value ("YYYY-MM-DD"、timeZone のローカル日付) */
export function msToDateValue(ms: number, timeZone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString();
}

/** <input type="date"> の value → その日のローカル 0:00 の epoch ms */
export function dateValueToMs(value: string, timeZone: string): number {
  return Temporal.PlainDate.from(value).toZonedDateTime(timeZone).epochMilliseconds;
}

/**
 * draft.endMs (排他的、終了日の翌日 0:00) → 表示用の inclusive な終了日の value。
 * フォームの「終了日」欄はユーザーに馴染みのある inclusive 表記で見せる。
 */
export function msExclusiveToDateValue(ms: number, timeZone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .subtract({ days: 1 })
    .toString();
}

/** フォームの「終了日」欄 (inclusive) の value → draft.endMs (排他的、翌日 0:00) */
export function dateValueToExclusiveEndMs(value: string, timeZone: string): number {
  return Temporal.PlainDate.from(value).add({ days: 1 }).toZonedDateTime(timeZone)
    .epochMilliseconds;
}
