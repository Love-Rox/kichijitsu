import { Temporal } from "@js-temporal/polyfill";
import type { EventPatchRequest } from "@kichijitsu/shared";
import type { EventSeries } from "../model/series";
import type { AllDayOccurrence, Occurrence } from "../model/types";
import { eventPatchRequestFor, rawGoogleEventId, seriesInstanceEventId } from "./eventPatch";
import { resolveSendUpdates, type GuestNotify } from "./guestNotify";

/**
 * 繰り返し予定の「適用範囲」(2026-07-30)。編集フォームの保存とドラッグ移動の確定で
 * 「この予定のみ / すべての予定」のどちらに書き込むかを決める純関数群。
 *
 * ## なぜ切り出したか
 * これ以前は eventPatch.ts / eventEdit.ts が **常に** seriesInstanceEventId() を宛先にして
 * おり、シリーズ本体を触る経路が存在しなかった ―― 繰り返し予定を編集・移動しても必ず
 * 「この予定のみ」に落ち、利用者はシリーズ全体を変えたつもりになりえた。宛先 (どの
 * event id を patch するか) と、親を触るときに何を送ってよいかの判断は間違うと
 * **シリーズ全体を壊す**ので、判断だけをここに集めてテストで固める。
 *
 * ## Google Calendar API 側の事情
 *  - **この予定のみ**: インスタンス id (`<親の event id>_<originalStart の UTC basic>`) を
 *    patch する。従来どおりの挙動 (eventPatch.ts 参照)。
 *  - **すべて**: 親 (シリーズ) の event id をそのまま patch する。`events.patch` は
 *    指定した top-level フィールドだけをマージするので、`recurrence` を送らなければ
 *    RRULE も EXDATE も既存のまま保たれる ―― **ここで recurrence を送ると EXDATE
 *    (削除済みの回) を巻き添えで消してしまう**ため、絶対に送らない。
 *  - **これ以降**: Google Calendar API にネイティブの手段が無く、「元シリーズの RRULE を
 *    UNTIL で打ち切る」+「残りを新しい繰り返し予定として作る」の2回の書き込みを
 *    クライアントが自前で行う必要がある。途中で失敗すると予定が二重になる/消えるうえ、
 *    kichijitsu の作成経路 (events.insert) は recurrence も attendees も
 *    conferenceData も送れないため、後半のシリーズから参加者や Meet リンクが
 *    静かに落ちる。**安全に実装できないと判断したため、選択肢として提供しない。**
 *
 * ## 「すべて」で時刻を動かすときの制約 (canApplyScopeAll)
 * 親を patch すると変わるのは **DTSTART** であって、繰り返しのパターン (RRULE の
 * BYDAY/BYMONTHDAY) ではない。DTSTART だけを別の曜日へ動かすと
 * `DTSTART=水曜 + RRULE:FREQ=WEEKLY;BYDAY=MO` のような食い違いが残り、展開結果が
 * 利用者の見たものと一致しなくなる。かといって recurrence を送れば上記のとおり
 * EXDATE を壊す。そこで **親の DTSTART の日付 (シリーズのタイムゾーンでのローカル日)
 * が変わらない範囲でだけ「すべて」を提供する**: 時刻だけの移動・長さの変更・内容の
 * 変更は全て通り、日をまたぐ移動では「すべて」を選択肢に出さない
 * (kichijitsu はそもそも RRULE を編集できないので、繰り返しのパターンを変えるのは
 * Google 側の仕事、という既存の立て付けとも揃う)。
 */

/** 適用範囲。"following" (これ以降) は上記の理由により提供しない */
export type RecurrenceScope = "this" | "all";

/**
 * 編集フォームの保存で、適用範囲の問いかけを利用者がキャンセルしたときに投げるエラー
 * (sync/eventRsvp.ts の RsvpNotAttendeeError と同じ流儀の番兵)。
 *
 * onSave の Promise を reject させないと EventDetailCard が `.then(onClose)` で
 * 詳細ポップオーバーを閉じてしまい、入力内容が黙って捨てられる。かといって普通の
 * エラーにすると「保存できませんでした」の赤字が出て、**キャンセルしたのに失敗した
 * ように見える** ―― EventEditForm がこの型だけを見分けて、何も言わずフォームを
 * 開いたままにする。
 */
export class EditScopeCancelledError extends Error {
  constructor() {
    super("kichijitsu: recurrence scope selection cancelled");
    this.name = "EditScopeCancelledError";
  }
}

/** 既定の選択肢。Google カレンダーに合わせて「この予定のみ」(最も影響が小さい方) */
export const DEFAULT_RECURRENCE_SCOPE: RecurrenceScope = "this";

/** 適用範囲つきの宛先を決めるのに必要な、Occurrence/AllDayOccurrence の共通部分だけの形 */
export interface ScopeSubject {
  /** occurrence の id (`g:<accountId>:<calendarId>:<eventId>` もしくは `<seriesId>:<originalStartMs>`) */
  id: string;
  /** 繰り返しシリーズ由来なら親 series の id、単発なら null/undefined */
  seriesId?: string | null;
  /** シリーズ由来の場合のみ: 展開時の元の開始時刻 (epoch ms) */
  originalStartMs?: number;
}

/** 変更前/変更後の時間帯 (epoch ms)。「すべて」に写すときの差分の元になる */
export interface TimeRange {
  startMs: number;
  endMs: number;
}

/**
 * この subject が繰り返しシリーズの1回分か。単発予定 (seriesId 無し) や、シリーズ由来でも
 * originalStartMs を持たない (= どの回か特定できない) ものは false ―― **false のときは
 * 適用範囲を問いかけてはならない** (従来どおり黙ってその予定だけを書き換える)。
 */
export function isSeriesInstance(subject: ScopeSubject): boolean {
  return Boolean(subject.seriesId) && subject.originalStartMs !== undefined;
}

/** シリーズの DTSTART (壁時計 + IANA タイムゾーン) を epoch ms にする */
export function seriesDtstartMs(series: Pick<EventSeries, "dtstartIso" | "timeZone">): number {
  return Temporal.PlainDateTime.from(series.dtstartIso).toZonedDateTime(series.timeZone)
    .epochMilliseconds;
}

/** epoch ms を指定タイムゾーンのローカル日 (YYYY-MM-DD) にする。DTSTART の日付が動いたかの判定用 */
function localDateOf(ms: number, timeZone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(timeZone).toPlainDate()
    .toString();
}

/**
 * 変更前後の時間帯から、シリーズ全体に写すべき「ずらし量」を出す。
 *
 * 差分で持つのがポイント: この回に InstanceOverride があって既にシリーズの時刻からずれて
 * いる場合でも、**利用者がこの操作で動かした分だけ**をシリーズへ写せる (変更前の時刻を
 * そのままシリーズに書くと、その回のずれまでシリーズ全体に広がってしまう)。時刻を一切
 * 触っていない編集 (タイトルだけ変えた等) では両方 0 になり、親の DTSTART に指一本
 * 触れずに済む。
 */
export function seriesShiftFor(previous: TimeRange, next: TimeRange) {
  return {
    startDeltaMs: next.startMs - previous.startMs,
    endDeltaMs: next.endMs - previous.endMs,
  };
}

/** 適用範囲の判定に必要な入力 (「すべて」が選べるかと、実際の宛先の両方で同じものを使う) */
export interface RecurrenceScopeInput {
  subject: ScopeSubject;
  /** ローカルの series レコード。未取得/存在しない場合は null (= 「すべて」は選べない) */
  series?: EventSeries | null;
  /** 変更前の時間帯。時刻を触らない編集でも、変更後と同じ値を渡す */
  previous?: TimeRange;
  /** 変更後の時間帯 */
  next?: TimeRange;
}

/**
 * 「すべての予定」を選べるか。
 *
 *  - 繰り返しシリーズの1回分でなければ false (そもそも問いかけない)。
 *  - ローカルに series レコードが無ければ false ―― 親の DTSTART が分からないので、
 *    どこへ何を書けばよいか決められない。
 *  - 時刻を動かす場合は、**親の DTSTART のローカル日が変わらない**ときだけ true
 *    (モジュール冒頭のコメント「すべて」で時刻を動かすときの制約を参照)。
 */
export function canApplyScopeAll({
  subject,
  series,
  previous,
  next,
}: RecurrenceScopeInput): boolean {
  if (!isSeriesInstance(subject) || !series) return false;
  if (!previous || !next) return true; // 時刻を動かさない編集は常に安全
  const { startDeltaMs } = seriesShiftFor(previous, next);
  if (startDeltaMs === 0) return true;
  const parentStartMs = seriesDtstartMs(series);
  return (
    localDateOf(parentStartMs, series.timeZone) ===
    localDateOf(parentStartMs + startDeltaMs, series.timeZone)
  );
}

/**
 * この操作で利用者に提示してよい適用範囲。**繰り返しでない予定では空配列**を返す
 * ―― 呼び出し側はこれが空なら問いかけを一切出さず、従来どおりそのまま書き込む。
 * 「すべて」が選べない繰り返し予定では `["this"]` (選択肢は1つだが、繰り返しの1回分
 * だけを変えることは伝える) になる。
 */
export function availableRecurrenceScopes(input: RecurrenceScopeInput): readonly RecurrenceScope[] {
  if (!isSeriesInstance(input.subject)) return [];
  return canApplyScopeAll(input) ? ["this", "all"] : ["this"];
}

/**
 * POST /api/event/patch の「宛先」。startMs/endMs は **送る場合のみ** 埋まる ――
 * undefined は「時刻には触らない」で、サーバーは start/end を PATCH body に含めない
 * (protocol.ts の EventPatchRequest 参照)。内容だけを変える「すべて」で親の DTSTART を
 * 無用に書き直さないための逃げ道。
 */
export interface ScopedPatchTarget {
  eventId: string;
  startMs?: number;
  endMs?: number;
}

/**
 * どの Google event id を、どの時間帯で patch するかを決める中心の純関数。
 *
 *  - scope==="this" (および繰り返しでない予定) は従来どおり: シリーズ由来ならインスタンス
 *    id、単発なら occurrence の id から取った生の event id に、変更後の時間帯をそのまま送る。
 *  - scope==="all" は親 (シリーズ) の event id へ。時刻は「変更前後の差分を親の DTSTART に
 *    足したもの」を送り、差分が両方 0 なら時刻自体を送らない。canApplyScopeAll が false の
 *    ときは **null** を返す(呼び出し側はそもそもこの範囲を選ばせてはいけない)。
 *
 * id の形が壊れている場合は rawGoogleEventId が throw する ―― 従来どおり呼び出し側
 * (buildEventPatchRequest 等) の try/catch で null に落ちる。
 */
export function resolveScopedPatchTarget({
  subject,
  scope,
  series,
  previous,
  next,
}: RecurrenceScopeInput & { scope: RecurrenceScope; next: TimeRange }): ScopedPatchTarget | null {
  if (scope === "all") {
    if (!series || !canApplyScopeAll({ subject, series, previous, next })) return null;
    const eventId = rawGoogleEventId(series.id);
    if (!previous) return { eventId };
    const { startDeltaMs, endDeltaMs } = seriesShiftFor(previous, next);
    // 時刻を一切動かしていないなら start/end は送らない (親の DTSTART を書き直さない)
    if (startDeltaMs === 0 && endDeltaMs === 0) return { eventId };
    const parentStartMs = seriesDtstartMs(series);
    const parentEndMs = parentStartMs + series.durationMin * 60_000;
    return {
      eventId,
      startMs: parentStartMs + startDeltaMs,
      endMs: parentEndMs + endDeltaMs,
    };
  }

  const eventId =
    subject.seriesId && subject.originalStartMs !== undefined
      ? seriesInstanceEventId(subject.seriesId, subject.originalStartMs)
      : rawGoogleEventId(subject.id);
  return { eventId, startMs: next.startMs, endMs: next.endMs };
}

/**
 * subject + 適用範囲 + 変更後の内容から POST /api/event/patch の body を組み立てる。
 * ドラッグ確定 (useEventMutations の persist) と編集フォーム保存 (eventEdit の
 * buildEventEditPatchRequest) の**両方が通る唯一の入口**で、宛先の決定はすべて
 * resolveScopedPatchTarget に一本化されている。
 *
 * ゲストへの通知 (2026-07-31) もここで確定させる ―― この関数が唯一の組み立て口である以上、
 * ここで sendUpdates を必ず埋めておけば「付け忘れて Google の未文書の既定に落ちる」経路が
 * 構造的に無くなる (sync/guestNotify.ts の resolveSendUpdates)。notify を渡さなくても
 * 値は必ず入る: 訊いていない相手 (ゲスト無し・非主催者) には externalOnly が入り、
 * 実質的に何も起きない。
 *
 * 返り値が null になるのは、
 *  - 書き戻し対象でない (source !== 'google'、accountId/calendarId が無い)
 *  - scope==='all' が選べない状態 (series が無い / 日をまたぐ移動) — 呼び出し側の
 *    availableRecurrenceScopes で弾かれているはずだが、念のため
 *  - id の形が壊れていて event id を取り出せない (console.error して null)
 * のいずれか。
 */
export function buildScopedEventPatchRequest({
  subject,
  scope,
  series,
  previous,
  next,
  timeZone,
  fields,
  notify,
}: {
  subject: Occurrence | AllDayOccurrence;
  scope: RecurrenceScope;
  series?: EventSeries | null;
  previous?: TimeRange;
  next: TimeRange;
  timeZone: string;
  /** 編集フォームから来る内容の変更。ドラッグ移動では省略する (時刻だけを触る) */
  fields?: { summary?: string; location?: string; description?: string; isAllDay?: boolean };
  /**
   * 確認ダイアログで選ばれたゲストへの通知 (2026-07-31)。訊いていない場合は省略でよい
   * ―― resolveSendUpdates が subject を見て安全側 (externalOnly) に倒す。
   */
  notify?: GuestNotify;
}): EventPatchRequest | null {
  try {
    const target = resolveScopedPatchTarget({ subject, scope, series, previous, next });
    if (!target) return null;
    const request = eventPatchRequestFor(subject, target, timeZone);
    if (!request) return null;
    const withNotify: EventPatchRequest = {
      ...request,
      sendUpdates: resolveSendUpdates(subject, notify),
    };
    return fields ? { ...withNotify, ...fields } : withNotify;
  } catch (err) {
    console.error("kichijitsu: failed to build EventPatchRequest", err);
    return null;
  }
}

/**
 * 「すべて」を選んだときの、**ローカルの series レコード**の更新後の姿。
 *
 * 楽観表示はこれを putSeries してから reexpandCurrentWindow を呼ぶだけで済ませる
 * (useEventMutations 参照) ―― シリーズ定義を書き換えて既存の再展開機構に流せば、
 * 展開済み occurrence 全体が一貫して動く。失敗時は変更前の series を書き戻して
 * もう一度再展開すればロールバックできる。
 *
 * exdatesMs と InstanceOverride は **意図的に触らない**: Google 側の EXDATE は絶対時刻の
 * 行として親に残り、DTSTART を動かしても一緒には動かない。ローカルだけ辻褄を合わせると
 * 次の同期で食い違うので、Google の挙動に合わせてそのまま残す。
 */
export function applyScopeAllToSeries({
  series,
  previous,
  next,
  fields,
}: {
  series: EventSeries;
  /** 変更前後の時間帯。時刻を触らない編集では省略できる */
  previous?: TimeRange;
  next?: TimeRange;
  fields?: { title?: string; location?: string; description?: string };
}): EventSeries {
  const updated: EventSeries = { ...series };
  if (fields?.title !== undefined) updated.title = fields.title;
  // 空文字は「クリア」なので undefined に落とす (EventPatchRequest の扱いと揃える)
  if (fields?.location !== undefined) updated.location = fields.location || undefined;
  if (fields?.description !== undefined) updated.description = fields.description || undefined;

  if (previous && next) {
    const { startDeltaMs, endDeltaMs } = seriesShiftFor(previous, next);
    if (startDeltaMs !== 0 || endDeltaMs !== 0) {
      const parentStartMs = seriesDtstartMs(series);
      const parentEndMs = parentStartMs + series.durationMin * 60_000;
      const nextStartMs = parentStartMs + startDeltaMs;
      const nextEndMs = parentEndMs + endDeltaMs;
      updated.dtstartIso = Temporal.Instant.fromEpochMilliseconds(nextStartMs)
        .toZonedDateTimeISO(series.timeZone)
        .toPlainDateTime()
        .toString({ smallestUnit: "minute" });
      updated.durationMin = Math.round((nextEndMs - nextStartMs) / 60_000);
    }
  }
  return updated;
}
