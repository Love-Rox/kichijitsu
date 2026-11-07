import { instanceId } from "@kichijitsu/web/model/series";
import type { InstanceOverride } from "@kichijitsu/web/model/series";
import type { AllDayOccurrence, Occurrence } from "@kichijitsu/web/model/types";
import { isEditableEventSubject } from "@kichijitsu/web/sync/eventEdit";
import { buildEventColorRequest } from "@kichijitsu/web/sync/eventColor";
import { buildEventDeleteRequest } from "@kichijitsu/web/sync/eventPatch";
import { shouldAskGuestNotify, type GuestNotify } from "@kichijitsu/web/sync/guestNotify";
import type { EventColorRequest, EventCreateResponse } from "@kichijitsu/shared";
import { GOOGLE_COLOR_MAP } from "@kichijitsu/web/sync/mapGoogle";
import {
  buildEventCreateRequest,
  buildPendingAllDayOccurrence,
  buildPendingOccurrence,
  finalizeCreatedAllDayOccurrence,
  finalizeCreatedOccurrence,
  type EventCreateDraft,
  type WriteTargetCandidate,
} from "@kichijitsu/web/sync/eventCreate";
import { mergeOverridePatch, resolveOverrideRef } from "@kichijitsu/web/sync/overridePatch";
import {
  applyDraftToAllDayOccurrence,
  applyDraftToOccurrence,
  buildEventEditPatchRequest,
  subjectTimeRange,
  type EventEditDraft,
} from "@kichijitsu/web/sync/eventEdit";
import {
  applyScopeAllToSeries,
  availableRecurrenceScopes,
  DEFAULT_RECURRENCE_SCOPE,
  EditScopeCancelledError,
  isSeriesInstance,
  type RecurrenceScope,
} from "@kichijitsu/web/sync/recurrenceScope";
import { buildEventRsvpRequest } from "@kichijitsu/web/sync/eventRsvp";
import {
  applyGuestChangesLocally,
  buildEventGuestsRequest,
  type GuestChange,
} from "@kichijitsu/web/sync/eventGuests";
import type { RsvpResponseStatus } from "@kichijitsu/shared";
import { ApiError, apiFetch } from "./api";
import type { CalendarData } from "./calendarData";
import {
  removeAllDay,
  removeOverride,
  removeSingle,
  upsertAllDay,
  upsertOverride,
  upsertSeries,
  upsertSingle,
} from "./localDb";

/**
 * 予定の変更 (楽観的更新 + サーバーへの書き戻し)。Web 版の useDeleteOccurrence と同じ考え方:
 *   1. 手元のデータ(画面と SQLite)を、サーバーの応答を待たずに書き換える
 *   2. POST /api/event/delete で Google へ書き戻す
 *   3. 失敗したら、手元のデータを元に戻して例外を投げる(呼び出し側がエラーを知らせる)
 */
export type EventSubject = Occurrence | AllDayOccurrence;
export type ApplyChange = (update: (data: CalendarData) => CalendarData) => void;

export const isTimed = (s: EventSubject): s is Occurrence => "startMs" in s;

/** 削除できる予定か。Google 由来で、自動生成のミラーや Busy のプレースホルダではないもの。 */
export function canDelete(subject: EventSubject): boolean {
  return isEditableEventSubject(subject);
}

/** 削除でゲストへの通知を訊くか(ゲストがいて、自分が主催のとき)。 */
export function asksGuestNotify(subject: EventSubject): boolean {
  return shouldAskGuestNotify(subject);
}

export async function deleteEvent(
  subject: EventSubject,
  notify: GuestNotify | undefined,
  apply: ApplyChange,
  data: CalendarData,
): Promise<void> {
  const request = buildEventDeleteRequest(subject, notify);
  if (!request) throw new Error("この予定は削除できません");

  // ---- 楽観的に手元から消す(元に戻す関数も用意する) ----
  let rollback: () => Promise<void>;
  if (!isTimed(subject)) {
    apply((d) => ({ ...d, allDays: d.allDays.filter((a) => a.id !== subject.id) }));
    await removeAllDay(subject.id);
    rollback = async () => {
      apply((d) => ({ ...d, allDays: [...d.allDays, subject] }));
      await upsertAllDay(subject);
    };
  } else if (subject.seriesId && subject.originalStartMs !== undefined) {
    // 繰り返しの1回分: その回だけを「キャンセル」する override (patch: null) を足す
    const id = instanceId(subject.seriesId, subject.originalStartMs);
    const previous = data.overrides.find((o) => o.id === id);
    const cancel: InstanceOverride = {
      id,
      seriesId: subject.seriesId,
      originalStartMs: subject.originalStartMs,
      patch: null,
    };
    apply((d) => ({ ...d, overrides: [...d.overrides.filter((o) => o.id !== id), cancel] }));
    await upsertOverride(cancel);
    rollback = async () => {
      apply((d) => ({
        ...d,
        overrides: [...d.overrides.filter((o) => o.id !== id), ...(previous ? [previous] : [])],
      }));
      if (previous) await upsertOverride(previous);
      else await removeOverride(id);
    };
  } else {
    apply((d) => ({ ...d, singles: d.singles.filter((o) => o.id !== subject.id) }));
    await removeSingle(subject.id);
    rollback = async () => {
      apply((d) => ({ ...d, singles: [...d.singles, subject] }));
      await upsertSingle(subject);
    };
  }

  // ---- サーバーへ書き戻す。失敗(通信エラー・401・サーバーの拒否)なら元に戻す ----
  try {
    const res = await apiFetch<{ ok: boolean }>("/api/event/delete", {
      method: "POST",
      body: JSON.stringify(request),
    });
    if (!res?.ok) throw new Error("サーバーが削除を受け付けませんでした");
  } catch (e) {
    await rollback();
    throw e;
  }
}

/**
 * 予定の作成 (楽観的更新 + 書き戻し)。Web 版の useCreateEvent と同じ流れ:
 *   仮の予定 (local-pending-<uuid>) を手元に入れて即座に表示 → POST /api/event/create →
 *   確定 id (g:<accountId>:<calendarId>:<eventId>) の予定に差し替え。失敗したら仮の予定を消して例外を投げる。
 * 確定 id は、あとで同期で届く同じ予定の id と一致するので、重複表示にならない。
 */
export async function createEvent(
  draft: EventCreateDraft,
  target: WriteTargetCandidate,
  timeZone: string,
  apply: ApplyChange,
): Promise<void> {
  if (draft.isAllDay) {
    const pending = buildPendingAllDayOccurrence({ draft, target, timeZone });
    apply((d) => ({ ...d, allDays: [...d.allDays, pending] }));
    await upsertAllDay(pending);
    try {
      const eventId = await postCreate(draft, target, timeZone);
      const finalized = finalizeCreatedAllDayOccurrence(pending, target, eventId);
      apply((d) => ({ ...d, allDays: [...d.allDays.filter((a) => a.id !== pending.id), finalized] }));
      await removeAllDay(pending.id);
      await upsertAllDay(finalized);
    } catch (e) {
      apply((d) => ({ ...d, allDays: d.allDays.filter((a) => a.id !== pending.id) }));
      await removeAllDay(pending.id);
      throw e;
    }
    return;
  }

  const pending = buildPendingOccurrence({ draft, target });
  apply((d) => ({ ...d, singles: [...d.singles, pending] }));
  await upsertSingle(pending);
  try {
    const eventId = await postCreate(draft, target, timeZone);
    const finalized = finalizeCreatedOccurrence(pending, target, eventId);
    apply((d) => ({ ...d, singles: [...d.singles.filter((o) => o.id !== pending.id), finalized] }));
    await removeSingle(pending.id);
    await upsertSingle(finalized);
  } catch (e) {
    apply((d) => ({ ...d, singles: d.singles.filter((o) => o.id !== pending.id) }));
    await removeSingle(pending.id);
    throw e;
  }
}

async function postCreate(
  draft: EventCreateDraft,
  target: WriteTargetCandidate,
  timeZone: string,
): Promise<string> {
  const res = await apiFetch<EventCreateResponse>("/api/event/create", {
    method: "POST",
    body: JSON.stringify(buildEventCreateRequest({ draft, target, timeZone })),
  });
  if (!res?.ok || !res.eventId) throw new Error("サーバーが作成を受け付けませんでした");
  return res.eventId;
}

/** 適用範囲とゲストへの通知を訊く関数。キャンセルなら null を返す(呼び出し側が画面の Alert で実装する)。 */
export type AskScope = (input: {
  title: string;
  scopes: readonly RecurrenceScope[];
  askNotify: boolean;
}) => Promise<{ scope: RecurrenceScope; notify: GuestNotify | undefined } | null>;

/**
 * 予定の編集の保存。Web 版の useSaveEdit と同じ「保存ボタン方式」: 楽観的更新はせず、
 * POST /api/event/patch が成功してから手元(画面と SQLite)へ反映する。失敗は例外を投げ、
 * フォームを開いたまま再試行できるようにする。
 *   - 繰り返しの1回分は、適用範囲(この予定のみ/すべての予定)を訊く。ゲストがいて自分が主催なら通知の有無も訊く
 *   - 「すべての予定」はシリーズ本体を書き換える(展開は表示のたびに行うので、そのまま全体に反映される)
 */
export async function saveEdit(
  original: EventSubject,
  draft: EventEditDraft,
  timeZone: string,
  apply: ApplyChange,
  data: CalendarData,
  ask: AskScope,
): Promise<void> {
  const previousRange = subjectTimeRange(original, timeZone);
  const nextRange = { startMs: draft.startMs, endMs: draft.endMs };
  const series = isSeriesInstance(original)
    ? (data.series.find((s) => s.id === original.seriesId) ?? null)
    : null;
  const scopes = availableRecurrenceScopes({
    subject: original,
    series,
    previous: previousRange,
    next: nextRange,
  });
  const askNotify = shouldAskGuestNotify(original);

  let scope: RecurrenceScope = DEFAULT_RECURRENCE_SCOPE;
  let notify: GuestNotify | undefined;
  if (scopes.length > 0 || askNotify) {
    const chosen = await ask({ title: draft.title || original.title, scopes, askNotify });
    if (chosen === null) throw new EditScopeCancelledError();
    scope = chosen.scope;
    notify = chosen.notify;
  }

  const patch = buildEventEditPatchRequest(original, draft, timeZone, scope, series, notify);
  if (!patch) throw new Error("この予定は編集できません");
  const res = await apiFetch<{ ok: boolean }>("/api/event/patch", {
    method: "POST",
    body: JSON.stringify(patch),
  });
  if (!res?.ok) throw new Error("サーバーが変更を受け付けませんでした");

  // ---- ここまで来たら Google への書き戻しは成功済み。手元へ反映する ----
  if (scope === "all" && series) {
    const next = applyScopeAllToSeries({
      series,
      previous: previousRange,
      next: nextRange,
      fields: { title: draft.title, location: draft.location, description: draft.description },
    });
    apply((d) => ({ ...d, series: d.series.map((s) => (s.id === next.id ? next : s)) }));
    await upsertSeries(next);
    return;
  }

  const wasAllDay = !isTimed(original);
  if (draft.isAllDay) {
    const nextAllDay = applyDraftToAllDayOccurrence(original, draft, timeZone);
    if (!wasAllDay) {
      apply((d) => ({ ...d, singles: d.singles.filter((o) => o.id !== original.id) }));
      await removeSingle(original.id);
    }
    apply((d) => ({
      ...d,
      allDays: [...d.allDays.filter((a) => a.id !== nextAllDay.id), nextAllDay],
    }));
    await upsertAllDay(nextAllDay);
    return;
  }

  const nextOcc = applyDraftToOccurrence(original, draft);
  if (wasAllDay) {
    apply((d) => ({ ...d, allDays: d.allDays.filter((a) => a.id !== original.id) }));
    await removeAllDay(original.id);
  } else {
    const ref = resolveOverrideRef(original);
    if (ref) {
      // 繰り返しの1回分: 例外インスタンス (override) に編集内容を足す。既存の patch は保つ
      const existing = data.overrides.find((o) => o.id === ref.id) ?? null;
      const merged = mergeOverridePatch({
        ref,
        existing,
        fields: {
          title: draft.title,
          startMs: draft.startMs,
          endMs: draft.endMs,
          location: draft.location || undefined,
          description: draft.description || undefined,
        },
      });
      apply((d) => ({ ...d, overrides: [...d.overrides.filter((o) => o.id !== merged.id), merged] }));
      await upsertOverride(merged);
      return;
    }
  }
  apply((d) => ({ ...d, singles: [...d.singles.filter((o) => o.id !== nextOcc.id), nextOcc] }));
  await upsertSingle(nextOcc);
}

/**
 * 自分の出欠を変える(参加 / 未定 / 不参加)。Web 版と同じ「保存ボタン方式」: サーバーが受け付けて
 * から手元へ反映する。招待されていない予定は 422 になるので、専用のメッセージにする。
 * 反映後の予定を返す(詳細シートが、押したボタンの状態を、すぐ見せられるように)。
 */
export async function rsvp(
  subject: EventSubject,
  status: RsvpResponseStatus,
  apply: ApplyChange,
  data: CalendarData,
): Promise<EventSubject> {
  const request = buildEventRsvpRequest(subject, status);
  if (!request) throw new Error("この予定には返信できません");
  try {
    const res = await apiFetch<{ ok: boolean }>("/api/event/rsvp", {
      method: "POST",
      body: JSON.stringify(request),
    });
    if (!res?.ok) throw new Error("サーバーが返信を受け付けませんでした");
  } catch (e) {
    if (e instanceof ApiError && e.status === 422) {
      throw new Error("招待されていない予定には返信できません");
    }
    throw e;
  }

  // ---- ここまで来たら書き戻しは成功済み。手元へ反映する ----
  const updated = { ...subject, responseStatus: status } as EventSubject;
  if (!isTimed(updated)) {
    apply((d) => ({ ...d, allDays: d.allDays.map((a) => (a.id === updated.id ? updated : a)) }));
    await upsertAllDay(updated);
    return updated;
  }
  const ref = resolveOverrideRef(subject as Occurrence);
  if (ref) {
    // 繰り返しの1回分: 例外インスタンス (override) に返信を残す(再展開で元に戻らないように)
    const existing = data.overrides.find((o) => o.id === ref.id) ?? null;
    const merged = mergeOverridePatch({ ref, existing, fields: { responseStatus: status } });
    apply((d) => ({ ...d, overrides: [...d.overrides.filter((o) => o.id !== merged.id), merged] }));
    await upsertOverride(merged);
    return updated;
  }
  apply((d) => ({ ...d, singles: d.singles.map((o) => (o.id === updated.id ? updated : o)) }));
  await upsertSingle(updated);
  return updated;
}

/** 手元(画面の状態と SQLite)に、単発の予定 1 件を書き込む。ゲスト編集の楽観更新とロールバックに使う。 */
async function writeLocalSubject(subject: EventSubject, apply: ApplyChange): Promise<void> {
  if (!isTimed(subject)) {
    apply((d) => ({ ...d, allDays: d.allDays.map((a) => (a.id === subject.id ? subject : a)) }));
    await upsertAllDay(subject);
    return;
  }
  apply((d) => ({ ...d, singles: d.singles.map((o) => (o.id === subject.id ? subject : o)) }));
  await upsertSingle(subject);
}

/**
 * ゲストの追加・削除。Web 版と同じく、**楽観更新 + ロールバック**: 押した瞬間に一覧へ反映し、
 * サーバーが拒否したら元に戻す。送るのは差分(追加/削除するメール)だけで、サーバーが read-modify-write
 * する。主催者の単発予定だけが対象(canEditGuests)。招待は常に通知される(サーバー側で固定)。
 * 反映後の予定を返す(押したあとの一覧をすぐ見せるため)。
 */
export async function editGuests(
  subject: EventSubject,
  change: GuestChange,
  apply: ApplyChange,
): Promise<EventSubject> {
  const request = buildEventGuestsRequest(subject, change);
  if (!request) throw new Error("この予定のゲストは変更できません");
  const optimistic = { ...subject, attendees: applyGuestChangesLocally(subject.attendees, change) } as EventSubject;
  await writeLocalSubject(optimistic, apply);
  try {
    const res = await apiFetch<{ ok: boolean }>("/api/event/guests", {
      method: "POST",
      body: JSON.stringify(request),
    });
    if (!res?.ok) throw new Error("サーバーがゲストの変更を受け付けませんでした");
  } catch (e) {
    await writeLocalSubject(subject, apply); // ロールバック
    if (e instanceof ApiError && e.status === 422) {
      throw new Error("主催者でない予定のゲストは変更できません");
    }
    throw e;
  }
  return optimistic;
}

/**
 * 予定の色(Google の colorId)を変える。colorId が null なら、予定個別の色を外して、カレンダーの色に戻す。
 * 繰り返しの予定は scope で範囲を選ぶ(Web と同じ): "this" はその 1 回だけ(Google のインスタンスに書き、
 * 手元は例外インスタンス override に残す)、"all" はシリーズ全体(親に書き、series の色を書き換える)。
 */
export async function setEventColor(
  subject: EventSubject,
  colorId: string | null,
  apply: ApplyChange,
  data: CalendarData,
  scope: "this" | "all" = "this",
): Promise<EventSubject> {
  if (!subject.accountId || !subject.calendarId || subject.source !== "google") {
    throw new Error("この予定の色は変えられません");
  }
  const series = isTimed(subject) && subject.seriesId ? data.series.find((x) => x.id === subject.seriesId) : undefined;
  if (isTimed(subject) && subject.seriesId && !series) throw new Error("繰り返しの予定の元が見つかりません");
  const request: EventColorRequest | null = buildEventColorRequest(subject, colorId, scope);
  if (!request) throw new Error("この予定の色は変えられません");
  try {
    const res = await apiFetch<{ ok: boolean }>("/api/event/color", {
      method: "POST",
      body: JSON.stringify(request),
    });
    if (!res?.ok) throw new Error("サーバーが色の変更を受け付けませんでした");
  } catch (e) {
    if (e instanceof ApiError) throw new Error("色を変えられませんでした(" + e.status + ")");
    throw e;
  }

  // ---- 書き戻しは成功済み。手元へ反映する(保存ボタン方式) ----
  const hex = colorId ? GOOGLE_COLOR_MAP[colorId] : calendarColorOf(data, subject);
  const patch = { color: hex, hasCustomColor: colorId !== null };
  if (series && scope === "this") {
    // 繰り返しの 1 回分: 例外インスタンス (override) に色を残す(再展開で、シリーズの色に戻らないように)
    const ref = resolveOverrideRef(subject as Occurrence);
    if (ref) {
      const existing = data.overrides.find((o) => o.id === ref.id) ?? null;
      const merged = mergeOverridePatch({ ref, existing, fields: patch });
      apply((d) => ({ ...d, overrides: [...d.overrides.filter((o) => o.id !== merged.id), merged] }));
      await upsertOverride(merged);
    }
    return { ...(subject as Occurrence), ...patch };
  }
  if (series) {
    const nextSeries = { ...series, ...patch };
    apply((d) => ({ ...d, series: d.series.map((x) => (x.id === series.id ? nextSeries : x)) }));
    await upsertSeries(nextSeries);
    return { ...(subject as Occurrence), ...patch };
  }
  const updated = { ...subject, ...patch } as EventSubject;
  await writeLocalSubject(updated, apply);
  return updated;
}

/** 予定が属するカレンダーの色(個別色を外したときの表示色)。見つからなければ今の色のまま。 */
function calendarColorOf(data: CalendarData, subject: EventSubject): string {
  for (const a of data.accounts) {
    if (a.accountId !== subject.accountId) continue;
    const cal = (a.all ?? a.calendars).find((c) => c.id === subject.calendarId);
    if (cal?.backgroundColor) return cal.backgroundColor;
  }
  return subject.color;
}
