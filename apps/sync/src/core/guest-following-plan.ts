import { NotOrganizerError } from "./errors";
import { applyGuestChanges } from "./guest-edit";
import type { RawAttendee } from "../google/rsvp-raw";

/**
 * 「これ以降」でゲストを変える (シリーズの分割、2026-11-07) の**計画**を立てる純関数層。
 *
 * ## やること
 * Google Calendar API には「この予定とこれ以降」を直接指定する手段が無い。Google の画面が
 * やっているのと同じく、シリーズを2つに割る:
 *   1. 元のシリーズ (親) の RRULE に UNTIL を付けて、対象の回の直前で打ち切る
 *   2. 対象の回を開始日とする新しいシリーズを作る (ゲストの差分はこちらにだけ反映)
 * 書き込みは回数に依らず常に2回。1回ずつ書く方式だと、毎週の予定を何年も続けるシリーズで
 * 数百回の書き込みと通知メールになる。
 *
 * ## 安全に分割できない予定は、何も書かずに断る (SplitRefusalReason)
 * 分割は途中で壊すとシリーズが二重になる/消える。しかも**元の情報を全部写せる保証が無い**
 * (新規作成は events.insert で、参加者の返事・個別に変更した回などは引き継げない)。
 * そこで「確実に写せる形」の予定だけを通し、それ以外は理由つきで断る。
 */

export type SplitRefusalReason =
  /** 対象がシリーズの1回分ではない (recurringEventId が無い) */
  | "not_recurring"
  /** 繰り返しの定義が単純な RRULE 1本ではない (EXDATE/RDATE/複数 RRULE)。新シリーズへ正しく写せない */
  | "complex_recurrence"
  /** RRULE が COUNT (回数) で終わる。残りの回数を数え直す必要があり、安全に決められない */
  | "count_rule"
  /** 対象がシリーズの最初の回。「これ以降」は「すべての予定」と同じなので、そちらを使う */
  | "first_instance"
  /** 対象の回以降に、個別に変更した回がある。新シリーズへ引き継げず、打ち切りで失われる */
  | "has_future_exceptions"
  /** 通常の予定以外 (不在・集中時間・勤務場所など) */
  | "unsupported_type";

/** events.get / events.list が返す、分割の判断と複製に要る部分だけの形 (未知のものは透過) */
export interface RawTimeField {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface RawSeriesEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  colorId?: string;
  visibility?: string;
  transparency?: string;
  reminders?: unknown;
  guestsCanInviteOthers?: boolean;
  guestsCanModify?: boolean;
  guestsCanSeeOtherGuests?: boolean;
  extendedProperties?: unknown;
  eventType?: string;
  conferenceData?: {
    conferenceId?: string;
    conferenceSolution?: unknown;
    entryPoints?: unknown;
  };
  attendees?: RawAttendee[];
  organizer?: { self?: boolean };
  recurrence?: string[];
  recurringEventId?: string;
  iCalUID?: string;
  start?: RawTimeField;
  end?: RawTimeField;
  originalStartTime?: RawTimeField;
}

export interface SplitPlanInput {
  instance: RawSeriesEvent;
  master: RawSeriesEvent;
  /** 親と同じ iCalUID を持つ、親以外のイベント (個別に変更/削除した回) */
  exceptions: RawSeriesEvent[];
  change: { addEmails?: string[]; removeEmails?: string[] };
}

export type SplitPlan =
  | { ok: false; reason: SplitRefusalReason | "no_change" }
  | {
      ok: true;
      /** events.insert へ送る新シリーズの本体 */
      newEventBody: Record<string, unknown>;
      /** 親の events.patch へ送る recurrence (UNTIL を付けた1本) */
      truncatedRecurrence: string[];
      /** 新シリーズへ Meet の会議情報を写そうとしているか (写せなかったときの切り戻し判断に使う) */
      copiesConference: boolean;
    };

/** RFC 5545 の UTC basic 形式 (YYYYMMDDTHHMMSSZ) */
export function utcBasic(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** 時刻フィールドを UTC ms にする。終日 (date) は UTC の 0:00 として比較用に使う */
function timeMs(field: RawTimeField | undefined): number | null {
  if (!field) return null;
  const raw = field.dateTime ?? field.date;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

function dateBasic(date: string): string {
  return date.replace(/-/g, "");
}

function previousDateBasic(date: string): string {
  const ms = Date.parse(date) - 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

/** 親の RRULE に UNTIL を付けて (既存の UNTIL は置き換え)、対象の回の直前で打ち切る */
function withUntil(rrule: string, until: string): string {
  const parts = rrule
    .slice("RRULE:".length)
    .split(";")
    .filter((p) => p.length > 0 && !p.startsWith("UNTIL="));
  return `RRULE:${[...parts, `UNTIL=${until}`].join(";")}`;
}

function pickAttendee(a: RawAttendee): RawAttendee {
  const out: RawAttendee = { email: a.email };
  for (const key of ["displayName", "optional", "resource", "additionalGuests"] as const) {
    if (a[key] !== undefined) out[key] = a[key];
  }
  // 返事は引き継がない(新しい招待になる)。主催者(自分)だけは承諾済みにしておく
  if (a.organizer === true || a.self === true) out.responseStatus = "accepted";
  return out;
}

export function planFollowingSplit(input: SplitPlanInput): SplitPlan {
  const { instance, master, exceptions, change } = input;

  if (master.organizer?.self !== true || instance.organizer?.self !== true) {
    throw new NotOrganizerError();
  }
  if (!instance.recurringEventId || !instance.originalStartTime) {
    return { ok: false, reason: "not_recurring" };
  }
  if (master.eventType !== undefined && master.eventType !== "default") {
    return { ok: false, reason: "unsupported_type" };
  }

  const rules = master.recurrence ?? [];
  if (rules.length !== 1 || !rules[0].startsWith("RRULE:")) {
    return { ok: false, reason: "complex_recurrence" };
  }
  if (/(^|;)COUNT=/.test(rules[0])) {
    return { ok: false, reason: "count_rule" };
  }

  const targetMs = timeMs(instance.originalStartTime);
  const masterStartMs = timeMs(master.start);
  if (targetMs === null || masterStartMs === null) {
    return { ok: false, reason: "not_recurring" };
  }
  if (targetMs <= masterStartMs) {
    return { ok: false, reason: "first_instance" };
  }

  const isAllDay = instance.originalStartTime.date !== undefined;
  const exdates: string[] = [];
  for (const exception of exceptions) {
    const exMs = timeMs(exception.originalStartTime);
    if (exMs === null || exMs < targetMs) continue;
    if (exception.status !== "cancelled") {
      return { ok: false, reason: "has_future_exceptions" };
    }
    // 削除済みの回は、新シリーズでも出ないよう EXDATE で写す
    exdates.push(
      isAllDay
        ? `EXDATE;VALUE=DATE:${dateBasic(exception.originalStartTime!.date!)}`
        : `EXDATE:${utcBasic(exMs)}`,
    );
  }

  const { next, added, removed } = applyGuestChanges(master.attendees ?? [], change);
  if (added === 0 && removed === 0) {
    return { ok: false, reason: "no_change" };
  }

  const until = isAllDay
    ? previousDateBasic(instance.originalStartTime.date!)
    : utcBasic(targetMs - 1000);

  const timeZone = master.start?.timeZone;
  const withZone = (field: RawTimeField | undefined): RawTimeField | undefined => {
    if (!field) return undefined;
    return field.dateTime && !field.timeZone && timeZone ? { ...field, timeZone } : field;
  };

  const copiesConference = Boolean(master.conferenceData?.conferenceId);
  const newEventBody: Record<string, unknown> = {
    summary: master.summary,
    description: master.description,
    location: master.location,
    colorId: master.colorId,
    visibility: master.visibility,
    transparency: master.transparency,
    reminders: master.reminders,
    guestsCanInviteOthers: master.guestsCanInviteOthers,
    guestsCanModify: master.guestsCanModify,
    guestsCanSeeOtherGuests: master.guestsCanSeeOtherGuests,
    extendedProperties: master.extendedProperties,
    start: withZone(instance.start),
    end: withZone(instance.end),
    recurrence: [rules[0], ...exdates],
    attendees: next.map(pickAttendee),
  };
  if (copiesConference) {
    newEventBody.conferenceData = {
      conferenceId: master.conferenceData!.conferenceId,
      conferenceSolution: master.conferenceData!.conferenceSolution,
      entryPoints: master.conferenceData!.entryPoints,
    };
  }
  // undefined のキーは JSON.stringify が落とすが、テストで読みやすいようここで除いておく
  for (const key of Object.keys(newEventBody)) {
    if (newEventBody[key] === undefined) delete newEventBody[key];
  }

  return {
    ok: true,
    newEventBody,
    truncatedRecurrence: [withUntil(rules[0], until)],
    copiesConference,
  };
}
