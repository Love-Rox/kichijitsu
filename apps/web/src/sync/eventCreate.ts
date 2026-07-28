import { Temporal } from "@js-temporal/polyfill";
import type { EventCreateRequest } from "@kichijitsu/shared";
import type { AllDayOccurrence, Occurrence } from "../model/types";
import { msExclusiveToDateValue, msToDateValue, type EventEditDraft } from "./eventEdit";

/**
 * 新規予定の作成 (フェーズ5、2026-07-29 全項目入力に拡張) に関する純関数群。空き領域
 * クリック/ドラッグで確定した時間帯とフォームの入力から、POST /api/event/create の body
 * 組み立て・楽観的表示用の仮 occurrence 生成・成功後の確定 occurrence への差し替えを行う。
 * DOM/store に触れない副作用フリーの層としてここに切り出し、hooks/useEventMutations.ts の
 * createEvent から呼ぶ。
 */

/**
 * 新規予定の入力内容。**編集フォームの draft (EventEditDraft) と同じ形をそのまま使う**
 * (2026-07-29 全項目入力) ―― 作成と編集で入力できる項目を意図的に一致させ、同じ
 * EventEditForm・同じ validateEventEditDraft を両方で使い回すため。別名を置いてあるのは
 * 呼び出し側で「作成の draft」と読めるようにするだけの意図で、構造は完全に同一。
 */
export type EventCreateDraft = EventEditDraft;

/** 新規予定の書き込み先候補1件。App.tsx の selectedTargets() に primary フラグを足した形 */
export interface WriteTargetCandidate {
  accountId: string;
  calendarId: string;
  /** そのカレンダーが Google 上で primary か */
  primary?: boolean;
  /** カレンダー自体の色 (Google の backgroundColor)。新規 occurrence の色に使う */
  defaultColor?: string;
}

/** occurrence.color のフォールバック値。mapGoogle.ts の DEFAULT_COLOR と同じ */
const DEFAULT_EVENT_COLOR = "#3b82f6";

/**
 * 新規予定のデフォルトの書き込み先を1つ決める(複数選択時の規則)。
 * 選択中カレンダーのうち primary があればそれ、無ければ先頭 (candidates の並び順)。
 * 2026-07-29 以降、詳細フォームでは利用者がここで決まった既定を上書きして
 * 書き込み先を選べる (writeTargetKey / findWriteTarget) ―― この関数はあくまで
 * 「速い経路 (ドラッグ→タイトル→Enter) と詳細フォームの初期値」を決める規則。
 */
export function resolveDefaultWriteTarget(
  candidates: readonly WriteTargetCandidate[],
): WriteTargetCandidate | null {
  if (candidates.length === 0) return null;
  return candidates.find((c) => c.primary) ?? candidates[0];
}

/**
 * 書き込み先候補を <select> の value 1個で扱うためのキー。layout/keys.ts の calendarKey と
 * 同じ `${accountId}:${calendarId}` 形式 (calendarLookup を引くのにそのまま使える)。
 */
export function writeTargetKey(target: WriteTargetCandidate): string {
  return `${target.accountId}:${target.calendarId}`;
}

/** writeTargetKey で選ばれた候補を引き当てる。見つからなければ null (選択肢が消えた場合の保険) */
export function findWriteTarget(
  candidates: readonly WriteTargetCandidate[],
  key: string,
): WriteTargetCandidate | null {
  return candidates.find((c) => writeTargetKey(c) === key) ?? null;
}

/**
 * 確定した時間帯から作成用 draft の初期値を作る (2026-07-29 全項目入力)。速い経路
 * (ドラッグ→タイトル→Enter) も詳細フォームもこの同じ draft を起点にする ―― 速い経路は
 * title だけ差し替えて作成し、詳細フォームはこれを初期値として EventEditForm に渡す。
 */
export function buildCreateDraft(
  startMs: number,
  endMs: number,
  title = "",
): EventCreateDraft {
  return { title, location: "", description: "", isAllDay: false, startMs, endMs };
}

/**
 * draft の正規化。タイトルの前後空白だけを落とす ―― 速い経路 (DayColumn のインライン入力) が
 * 元々 title.trim() してから作成していたので、詳細フォーム経由でも同じ結果になるように
 * ここに一本化した。説明は複数行のテキストで前後の空行にも意味があり得るため触らない。
 */
export function normalizeEventCreateDraft(draft: EventCreateDraft): EventCreateDraft {
  return { ...draft, title: draft.title.trim(), location: draft.location.trim() };
}

/**
 * POST /api/event/create の body を組み立てる。
 * 空欄 (location/description) と isAllDay:false はキー自体を含めない ―― 作成には
 * 「クリアすべき既存値」が無く、EventPatchRequest の「空文字はクリア」とは意味が違うため
 * (protocol.ts の EventCreateRequest コメント参照)。
 */
export function buildEventCreateRequest(params: {
  draft: EventCreateDraft;
  target: WriteTargetCandidate;
  timeZone: string;
}): EventCreateRequest {
  const draft = normalizeEventCreateDraft(params.draft);
  return {
    accountId: params.target.accountId,
    calendarId: params.target.calendarId,
    title: draft.title,
    startMs: draft.startMs,
    endMs: draft.endMs,
    timeZone: params.timeZone,
    ...(draft.location ? { location: draft.location } : {}),
    ...(draft.description ? { description: draft.description } : {}),
    ...(draft.isAllDay ? { isAllDay: true } : {}),
  };
}

/** 楽観的作成用の仮 occurrence の id。crypto.randomUUID() で衝突しない値を作る */
export function buildPendingOccurrenceId(): string {
  return `local-pending-${crypto.randomUUID()}`;
}

/**
 * 楽観的表示用の仮 occurrence を作る。POST /api/event/create の応答を待たずに
 * 即座に store/IndexedDB へ入れて表示するためのもの。
 * source は 'local' にしておく — まだ Google 側に存在しない予定を 'google' として
 * 扱うと、この仮 occurrence がドラッグされた際に buildEventPatchRequest が
 * (存在しない) event id で書き戻しを試みてしまうため。確定後 (finalizeCreatedOccurrence)
 * に初めて 'google' source・確定 id へ差し替える。
 * location/description も写す (2026-07-29 全項目入力) ―― 詳細フォームで入れた場所/説明が
 * 確定を待たずにホバー/詳細ポップオーバーへ出るように。
 */
export function buildPendingOccurrence(params: {
  draft: EventCreateDraft;
  target: WriteTargetCandidate;
}): Occurrence {
  const draft = normalizeEventCreateDraft(params.draft);
  return {
    id: buildPendingOccurrenceId(),
    seriesId: null,
    title: draft.title,
    startMs: draft.startMs,
    endMs: draft.endMs,
    color: params.target.defaultColor ?? DEFAULT_EVENT_COLOR,
    hasCustomColor: false,
    source: "local",
    location: draft.location || undefined,
    description: draft.description || undefined,
  };
}

/**
 * 終日予定版の仮 occurrence (2026-07-29 全項目入力)。draft.endMs は排他的 (終了日の翌日
 * 0:00) なので、表示用の inclusive な endDate へ1日前倒しする ―― mapGoogle.ts の
 * buildAllDay / eventEdit.ts の applyDraftToAllDayOccurrence と同じ規則・同じクランプ。
 */
export function buildPendingAllDayOccurrence(params: {
  draft: EventCreateDraft;
  target: WriteTargetCandidate;
  timeZone: string;
}): AllDayOccurrence {
  const draft = normalizeEventCreateDraft(params.draft);
  const startDate = msToDateValue(draft.startMs, params.timeZone);
  let endDate = msExclusiveToDateValue(draft.endMs, params.timeZone);
  if (Temporal.PlainDate.compare(endDate, startDate) < 0) endDate = startDate;
  return {
    id: buildPendingOccurrenceId(),
    seriesId: null,
    title: draft.title,
    startDate,
    endDate,
    color: params.target.defaultColor ?? DEFAULT_EVENT_COLOR,
    hasCustomColor: false,
    source: "local",
    location: draft.location || undefined,
    description: draft.description || undefined,
  };
}

/**
 * `g:<accountId>:<calendarId>:<eventId>` — mapGoogle.ts の eventKey() と同じ規則。
 * ここで組み立てた id が同期で還流してくる正本の id と一致することで、
 * 作成直後に SSE/同期が追いついても冪等に上書きされるだけで済む(重複表示しない)。
 */
function googleEventKey(target: WriteTargetCandidate, eventId: string): string {
  return `g:${target.accountId}:${target.calendarId}:${eventId}`;
}

/**
 * POST /api/event/create 成功後、仮 occurrence を確定 occurrence に差し替える。
 * source を 'google' にし、id を確定の `g:<accountId>:<calendarId>:<eventId>` に、
 * 色は書き込み先カレンダーの色 (hasCustomColor: false — 表示側 resolveDisplayColor が
 * calendarLookup のカレンダー色を都度再解決するので、ここでの色は初期値に過ぎない)。
 */
export function finalizeCreatedOccurrence(
  pending: Occurrence,
  target: WriteTargetCandidate,
  eventId: string,
): Occurrence {
  return {
    ...pending,
    id: googleEventKey(target, eventId),
    source: "google",
    accountId: target.accountId,
    calendarId: target.calendarId,
    color: target.defaultColor ?? pending.color,
    hasCustomColor: false,
  };
}

/** 終日予定版の確定差し替え (2026-07-29 全項目入力)。規則は finalizeCreatedOccurrence と同じ */
export function finalizeCreatedAllDayOccurrence(
  pending: AllDayOccurrence,
  target: WriteTargetCandidate,
  eventId: string,
): AllDayOccurrence {
  return {
    ...pending,
    id: googleEventKey(target, eventId),
    source: "google",
    accountId: target.accountId,
    calendarId: target.calendarId,
    color: target.defaultColor ?? pending.color,
    hasCustomColor: false,
  };
}
