import { Temporal } from "@js-temporal/polyfill";
import type { EventDeleteRequest, EventPatchRequest } from "@kichijitsu/shared";
import type { Occurrence } from "../model/types";
import { resolveSendUpdates, type GuestNotify } from "./guestNotify";

/**
 * ドラッグ確定を Google へ書き戻す (フェーズ5) ための、EventPatchRequest 組み立て純関数群。
 * occurrence の id 規則 (`g:<accountId>:<calendarId>:<eventId>`, protocol.ts 参照) から
 * Google の生 event id を取り出し、シリーズ由来ならインスタンス ID を組み立てる。
 */

/**
 * occurrence/series の id (`g:<accountId>:<calendarId>:<eventId>`) から Google の生 event id を取り出す。
 * eventId 自体にコロンは来ない前提だが、念のため 4番目以降のセグメントを ':' で
 * 再結合して安全に取り出す (mapGoogle.ts の eventKey() の逆変換)。
 */
export function rawGoogleEventId(id: string): string {
  const parts = id.split(":");
  if (parts.length < 4 || parts[0] !== "g") {
    throw new Error(`kichijitsu: not a google-scoped occurrence/series id: "${id}"`);
  }
  return parts.slice(3).join(":");
}

/**
 * epoch ms を UTC の RFC5545 basic 形式 (`YYYYMMDDTHHMMSSZ`) に変換する。
 * Google Calendar API の繰り返しインスタンス ID (`<parentId>_<originalStart>`) の
 * サフィックスに使う形式。
 */
export function utcBasicFromEpochMs(ms: number): string {
  const zdt = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO("UTC");
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${zdt.year}${pad(zdt.month)}${pad(zdt.day)}T${pad(zdt.hour)}${pad(zdt.minute)}${pad(zdt.second)}Z`;
}

/**
 * 繰り返しシリーズの1回分 (この予定のみ) を指す Google のインスタンス ID を組み立てる。
 * `<親の生 event id>_<originalStartMs の UTC basic 形式>` (protocol.ts の EventPatchRequest コメント参照)
 */
export function seriesInstanceEventId(seriesId: string, originalStartMs: number): string {
  return `${rawGoogleEventId(seriesId)}_${utcBasicFromEpochMs(originalStartMs)}`;
}

/**
 * occurrence から POST /api/event/patch の body を組み立てる部分のうち、**適用範囲に依らない
 * 部分**。宛先 (どの event id を、どの時刻で patch するか) の判断は sync/recurrenceScope.ts の
 * resolveScopedPatchTarget が持ち、この関数はそこから呼ばれる
 * (2026-07-30、繰り返し予定の適用範囲。逆向きに import しないのは循環参照を避けるため)。
 *
 * source !== 'google' や accountId/calendarId 欠落 (本来あり得ないが型上は optional) の場合は null。
 */
export function eventPatchRequestFor(
  subject: { source: string; accountId?: string; calendarId?: string },
  target: { eventId: string; startMs?: number; endMs?: number },
  timeZone: string,
): EventPatchRequest | null {
  if (subject.source !== "google" || !subject.accountId || !subject.calendarId) {
    return null;
  }
  return {
    accountId: subject.accountId,
    calendarId: subject.calendarId,
    eventId: target.eventId,
    startMs: target.startMs,
    endMs: target.endMs,
    timeZone,
  };
}

/**
 * occurrence から POST /api/event/delete の body を組み立てる。
 * eventId の組み立て規則は上の eventPatchRequestFor と全く同じ (rawGoogleEventId /
 * seriesInstanceEventId を再利用)。source !== 'google' や accountId/calendarId 欠落、
 * id のパース失敗時は null (呼び出し側で warn する)。
 *
 * ゲストへの通知 (2026-07-31) もここで確定させる ―― 削除の body を組み立てる口はここ1つ
 * しかないので、ここで sendUpdates を必ず埋めておけば「付け忘れて Google の未文書の既定に
 * 落ちる」経路が構造的に無くなる (更新側で buildScopedEventPatchRequest が果たしている役目と
 * 同じ)。判定は**更新と同じ** sync/guestNotify.ts の resolveSendUpdates を使い、削除用の
 * 規則は作らない。notify を渡さなくても値は必ず入る: 訊いていない相手 (ゲスト無し・
 * 非主催者) には externalOnly が入り、知らせる相手がいないので実質的に何も起きない。
 *
 * @param notify 確認ダイアログで選ばれた値。訊いていない場合は省略でよい
 */
export function buildEventDeleteRequest(
  occurrence: Occurrence,
  notify?: GuestNotify,
): EventDeleteRequest | null {
  if (occurrence.source !== "google" || !occurrence.accountId || !occurrence.calendarId) {
    return null;
  }
  try {
    const eventId =
      occurrence.seriesId && occurrence.originalStartMs !== undefined
        ? seriesInstanceEventId(occurrence.seriesId, occurrence.originalStartMs)
        : rawGoogleEventId(occurrence.id);
    return {
      accountId: occurrence.accountId,
      calendarId: occurrence.calendarId,
      eventId,
      sendUpdates: resolveSendUpdates(occurrence, notify),
    };
  } catch (err) {
    console.error("kichijitsu: failed to build EventDeleteRequest", err);
    return null;
  }
}
