import { instanceId } from "@kichijitsu/web/model/series";
import type { InstanceOverride } from "@kichijitsu/web/model/series";
import type { AllDayOccurrence, Occurrence } from "@kichijitsu/web/model/types";
import { isEditableEventSubject } from "@kichijitsu/web/sync/eventEdit";
import { buildEventDeleteRequest } from "@kichijitsu/web/sync/eventPatch";
import { shouldAskGuestNotify, type GuestNotify } from "@kichijitsu/web/sync/guestNotify";
import type { EventCreateResponse } from "@kichijitsu/shared";
import {
  buildEventCreateRequest,
  buildPendingAllDayOccurrence,
  buildPendingOccurrence,
  finalizeCreatedAllDayOccurrence,
  finalizeCreatedOccurrence,
  type EventCreateDraft,
  type WriteTargetCandidate,
} from "@kichijitsu/web/sync/eventCreate";
import { apiFetch } from "./api";
import type { CalendarData } from "./calendarData";
import {
  removeAllDay,
  removeOverride,
  removeSingle,
  upsertAllDay,
  upsertOverride,
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
