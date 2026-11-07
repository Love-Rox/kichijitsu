/**
 * デスクトップ版のメニューバー(トレイ)に出す「次の予定」の判定と文言 (2026-11-07)。
 *
 * 判定・文言づくりは、この純関数群に閉じる(テストのため)。時間駆動の配線は
 * hooks/useTrayNextEvent.ts、Rust への送出は同じファイルの setTrayStatus。
 * Rust 側は渡された文字をトレイに出すだけで、予定のデータは持たない(リマインダー通知と同じ分担)。
 */
import type { Occurrence } from "../model/types";
import { dayStartMs, plainDateOfMs } from "../layout/dayTime";
import { formatTime } from "../layout/gridMetrics";
import { resolveMeetingUrl } from "../layout/meetingLinks";
import { readStored, writeStored, type StorageLike } from "../layout/localStore";

const ENABLED_KEY = "kichijitsu:trayNextEvent";

/** メニューバーに次の予定を出すか(既定はオン)。壊れた値・保存なしは、オン */
export function getTrayNextEventEnabled(storage?: StorageLike): boolean {
  return readStored(ENABLED_KEY, (raw) => (raw === "off" ? false : raw === "on" ? true : null), true, storage);
}

export function setTrayNextEventEnabled(enabled: boolean, storage?: StorageLike): void {
  writeStored(ENABLED_KEY, enabled ? "on" : "off", storage);
}

/** 先の何時間ぶんまで「次の予定」として探すか。それより先の予定は出さない */
export const TRAY_LOOKAHEAD_MS = 12 * 60 * 60_000;

/** メニューバーに出すタイトルの上限(文字数)。長いと、ほかのメニューバーの項目を押しのける */
const TITLE_MAX = 18;

/**
 * 次の予定を選ぶ: 終わっていない(endMs > now)予定のうち、開始が最も早いもの。
 * 進行中の予定があれば、それが先に来る(開始が過去のため)。
 * 対象外: 不在・勤務場所・ブロックのミラー・辞退した予定。
 */
export function pickNextEvent(candidates: readonly Occurrence[], nowMs: number): Occurrence | null {
  let best: Occurrence | null = null;
  for (const o of candidates) {
    if (o.endMs <= nowMs) continue;
    if (o.isOutOfOffice || o.isWorkingLocation || o.isMirror) continue;
    if (o.responseStatus === "declined") continue;
    if (!best || o.startMs < best.startMs) best = o;
  }
  return best;
}

function clamp(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}

/** 「あと◯分」「あと◯時間◯分」。進行中は「進行中」 */
export function relativeLabel(startMs: number, nowMs: number): string {
  const min = Math.ceil((startMs - nowMs) / 60_000);
  if (min <= 0) return "進行中";
  if (min < 60) return `あと${min}分`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `あと${h}時間` : `あと${h}時間${m}分`;
}

export interface TrayStatus {
  /** メニューバーに出す短い文言。空なら何も出さない */
  title: string;
  /** マウスを載せたときの説明(長めでよい) */
  tooltip: string;
  /** トレイのメニューの「会議に参加」: 項目の文言と、開く URL(http/https のみ)。無ければ項目を出さない */
  joinLabel?: string;
  joinUrl?: string;
  /** トレイのメニューに並べる、今日のこれからの予定(文言と、開始時刻 epoch ms。同じ並び) */
  eventLabels: string[];
  eventStarts: number[];
}

/** トレイのメニューに並べる、今日の予定の最大件数(Rust 側の上限と同じ) */
export const TRAY_MAX_EVENTS = 8;

/**
 * タイトルは「10:30 定例」、1 時間以内なら「定例 あと15分」、進行中は「定例 進行中」。
 * 予定が無ければ、タイトルは空(アイコンだけ)。
 */
export function buildTrayStatus(event: Occurrence | null, nowMs: number, timeZone: string): TrayStatus {
  const empty = { eventLabels: [], eventStarts: [] };
  if (!event) return { title: "", tooltip: "kichijitsu", ...empty };
  const name = event.title.trim() || "(タイトルなし)";
  const soon = event.startMs - nowMs < 60 * 60_000;
  const title = soon
    ? `${clamp(name, TITLE_MAX)} ${relativeLabel(event.startMs, nowMs)}`
    : `${formatTime(event.startMs, timeZone)} ${clamp(name, TITLE_MAX)}`;
  const tooltip = `次の予定: ${formatTime(event.startMs, timeZone)} ${name}(${relativeLabel(event.startMs, nowMs)})`;
  return { title, tooltip, ...empty };
}

/** 次の予定に出す対象か(不在・勤務場所・ミラー・辞退を除く)。pickNextEvent と同じ規則 */
function isListable(o: Occurrence): boolean {
  return !(o.isOutOfOffice || o.isWorkingLocation || o.isMirror || o.responseStatus === "declined");
}

/**
 * 「次の会議」: 終わっていない予定のうち、開始が最も早く、ビデオ会議の URL(http/https)を持つもの。
 * 進行中の会議も対象(途中から参加できるように)。
 */
export function pickNextMeeting(
  candidates: readonly Occurrence[],
  nowMs: number,
): { event: Occurrence; url: string } | null {
  let best: { event: Occurrence; url: string } | null = null;
  for (const o of candidates) {
    if (o.endMs <= nowMs || !isListable(o)) continue;
    const url = resolveMeetingUrl(o.conferenceUrl, o.location);
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (!best || o.startMs < best.event.startMs) best = { event: o, url };
  }
  return best;
}

/** 今日のこれからの予定(進行中を含む)。開始順で、TRAY_MAX_EVENTS 件まで。終日の予定は、時刻が無いので含まない。 */
export function listTodayEvents(
  candidates: readonly Occurrence[],
  nowMs: number,
  timeZone: string,
): Occurrence[] {
  const endOfDay = dayStartMs(plainDateOfMs(nowMs, timeZone).add({ days: 1 }), timeZone);
  return candidates
    .filter((o) => o.endMs > nowMs && o.startMs < endOfDay && isListable(o))
    .sort((a, b) => a.startMs - b.startMs)
    .slice(0, TRAY_MAX_EVENTS);
}

/**
 * メニューバーとトレイのメニューに出す内容を、まとめて作る。
 * candidates は、いまから先の 12 時間ぶんほどの予定(store.getRange)。
 */
export function buildTrayInfo(
  candidates: readonly Occurrence[],
  nowMs: number,
  timeZone: string,
): TrayStatus {
  const status = buildTrayStatus(pickNextEvent(candidates, nowMs), nowMs, timeZone);
  const meeting = pickNextMeeting(candidates, nowMs);
  const today = listTodayEvents(candidates, nowMs, timeZone);
  return {
    ...status,
    ...(meeting
      ? {
          joinLabel: `${formatTime(meeting.event.startMs, timeZone)} ${meeting.event.title.trim() || "(タイトルなし)"}`,
          joinUrl: meeting.url,
        }
      : {}),
    eventLabels: today.map(
      (o) => `${formatTime(o.startMs, timeZone)} ${o.title.trim() || "(タイトルなし)"}`,
    ),
    eventStarts: today.map((o) => o.startMs),
  };
}

interface TauriGlobal {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}

/** Rust の set_tray_info を呼ぶ。デスクトップ版でない・失敗したときは false */
export async function setTrayStatus(status: TrayStatus): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri) return false;
  try {
    await tauri.core.invoke("set_tray_info", {
      title: status.title,
      tooltip: status.tooltip,
      joinLabel: status.joinLabel ?? null,
      joinUrl: status.joinUrl ?? null,
      eventLabels: status.eventLabels,
      eventStarts: status.eventStarts,
    });
    return true;
  } catch (err) {
    console.warn("kichijitsu: set_tray_info invoke failed", err);
    return false;
  }
}

/** ログイン時の自動起動(macOS)。確認と切り替え。デスクトップ版でなければ、確認は false、切り替えは false を返す */
export async function getAutostart(): Promise<boolean> {
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri) return false;
  try {
    return (await tauri.core.invoke("get_autostart")) === true;
  } catch {
    return false;
  }
}

export async function setAutostart(enabled: boolean): Promise<boolean> {
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri) return false;
  try {
    await tauri.core.invoke("set_autostart", { enabled });
    return true;
  } catch (err) {
    console.warn("kichijitsu: set_autostart invoke failed", err);
    return false;
  }
}
