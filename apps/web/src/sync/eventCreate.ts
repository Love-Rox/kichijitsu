import type { EventCreateRequest } from '@kichijitsu/shared'
import type { Occurrence } from '../model/types'

/**
 * 新規予定の作成 (フェーズ5) に関する純関数群。空き領域クリック/ドラッグで
 * 確定した時間帯・タイトルから、書き込み先カレンダーの決定・POST /api/event/create
 * の body 組み立て・楽観的表示用の仮 occurrence 生成・成功後の確定 occurrence への
 * 差し替えを行う。DOM/store に触れない副作用フリーの層としてここに切り出し、
 * App.tsx (handleCreate) から呼ぶ。
 */

/** 新規予定の書き込み先候補1件。App.tsx の selectedTargets() に primary フラグを足した形 */
export interface WriteTargetCandidate {
  accountId: string
  calendarId: string
  /** そのカレンダーが Google 上で primary か */
  primary?: boolean
  /** カレンダー自体の色 (Google の backgroundColor)。新規 occurrence の色に使う */
  defaultColor?: string
}

/** occurrence.color のフォールバック値。mapGoogle.ts の DEFAULT_COLOR と同じ */
const DEFAULT_EVENT_COLOR = '#3b82f6'

/**
 * 新規予定のデフォルトの書き込み先を1つ決める(複数選択時の規則)。
 * 選択中カレンダーのうち primary があればそれ、無ければ先頭 (candidates の並び順)。
 * TODO: 将来 UI で書き込み先を選べるようにする(いまは固定規則のみ)。
 */
export function resolveDefaultWriteTarget(
  candidates: readonly WriteTargetCandidate[],
): WriteTargetCandidate | null {
  if (candidates.length === 0) return null
  return candidates.find((c) => c.primary) ?? candidates[0]
}

/** POST /api/event/create の body を組み立てる */
export function buildEventCreateRequest(params: {
  title: string
  startMs: number
  endMs: number
  target: WriteTargetCandidate
  timeZone: string
}): EventCreateRequest {
  return {
    accountId: params.target.accountId,
    calendarId: params.target.calendarId,
    title: params.title,
    startMs: params.startMs,
    endMs: params.endMs,
    timeZone: params.timeZone,
  }
}

/** 楽観的作成用の仮 occurrence の id。crypto.randomUUID() で衝突しない値を作る */
export function buildPendingOccurrenceId(): string {
  return `local-pending-${crypto.randomUUID()}`
}

/**
 * 楽観的表示用の仮 occurrence を作る。POST /api/event/create の応答を待たずに
 * 即座に store/IndexedDB へ入れて表示するためのもの。
 * source は 'local' にしておく — まだ Google 側に存在しない予定を 'google' として
 * 扱うと、この仮 occurrence がドラッグされた際に buildEventPatchRequest が
 * (存在しない) event id で書き戻しを試みてしまうため。確定後 (finalizeCreatedOccurrence)
 * に初めて 'google' source・確定 id へ差し替える。
 */
export function buildPendingOccurrence(params: {
  title: string
  startMs: number
  endMs: number
  target: WriteTargetCandidate
}): Occurrence {
  return {
    id: buildPendingOccurrenceId(),
    seriesId: null,
    title: params.title,
    startMs: params.startMs,
    endMs: params.endMs,
    color: params.target.defaultColor ?? DEFAULT_EVENT_COLOR,
    hasCustomColor: false,
    source: 'local',
  }
}

/**
 * `g:<accountId>:<calendarId>:<eventId>` — mapGoogle.ts の eventKey() と同じ規則。
 * ここで組み立てた id が同期で還流してくる正本の id と一致することで、
 * 作成直後に SSE/同期が追いついても冪等に上書きされるだけで済む(重複表示しない)。
 */
function googleEventKey(target: WriteTargetCandidate, eventId: string): string {
  return `g:${target.accountId}:${target.calendarId}:${eventId}`
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
    source: 'google',
    accountId: target.accountId,
    calendarId: target.calendarId,
    color: target.defaultColor ?? pending.color,
    hasCustomColor: false,
  }
}
