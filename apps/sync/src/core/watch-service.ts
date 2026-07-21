import type { WatchRequest } from "@kichijitsu/shared";
import type { RegisteredWatch } from "../google/watch";
import type { WatchRow } from "./webhook";

export type { WatchRow } from "./webhook";

/** POST /api/watch (enabled=true) で Google への登録に成功した後、D1 へ挿入する行を組み立てる。 */
export function buildWatchRow(
  request: Pick<WatchRequest, "accountId" | "calendarId">,
  profileId: string,
  channelId: string,
  registered: RegisteredWatch,
  now: number,
): WatchRow {
  return {
    channel_id: channelId,
    resource_id: registered.resourceId,
    account_id: request.accountId,
    calendar_id: request.calendarId,
    profile_id: profileId,
    expiration_ms: registered.expiration,
    created_at: now,
  };
}

/** Cron 更新 (renewWatch) で古い行を置き換える、新しい channel_id の行を組み立てる。 */
export function buildRenewedWatchRow(
  oldRow: WatchRow,
  channelId: string,
  registered: RegisteredWatch,
  now: number,
): WatchRow {
  return {
    channel_id: channelId,
    resource_id: registered.resourceId,
    account_id: oldRow.account_id,
    calendar_id: oldRow.calendar_id,
    profile_id: oldRow.profile_id,
    expiration_ms: registered.expiration,
    created_at: now,
  };
}

const DEFAULT_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Cron (6時間おき) が再 watch すべき行を選別する。
 * `expiration_ms` が null (Google が expiration を返さなかった watch) は対象外にする —
 * 期限が分からない以上、安全側に倒して triggerしない (次の Cron 実行まで待つ)。
 */
export function selectWatchesNeedingRenewal(
  watches: WatchRow[],
  now: number,
  renewalWindowMs: number = DEFAULT_RENEWAL_WINDOW_MS,
): WatchRow[] {
  return watches.filter(
    (w) => w.expiration_ms !== null && w.expiration_ms - now <= renewalWindowMs,
  );
}

/**
 * POST /api/sync 成功後の watch 自己修復 (best-effort) で、watch を張り直すべきか判定する。
 *
 * watch 登録の正経路はクライアントがカレンダー選択をトグルした時の POST /api/watch
 * (enabled:true) のみであり、それ以外に watches 行を作る手段が無い。プロファイル作り直し
 * 事故などで watches 行が消えた/古いプロファイルに紐づいたまま残ったケースは、手でトグルし
 * 直す以外に直しようが無かった (実際に選択中 8 カレンダー中 7 個が無 watch になった障害が
 * あった)。ここでの判定は「張り直すべきか」だけで、実際の登録 (Google 呼び出し) は行わない。
 *
 * true になる条件:
 * - 行が無い (watches 消失)
 * - 行の profile_id が現プロファイルと異なる (古いプロファイル宛の watch は通知が
 *   届いても間違った ProfileHubDO に届く — webhook.ts の profile_id 参照)
 * - expiration_ms が過去 (Cron の renewWatch が更新し損ねた失効行)
 */
export function shouldEnsureWatch(
  existingRow: { profile_id: string; expiration_ms: number } | null,
  profileId: string,
  now: number,
): boolean {
  if (!existingRow) return true;
  if (existingRow.profile_id !== profileId) return true;
  if (existingRow.expiration_ms < now) return true;
  return false;
}

const WATCH_REPAIR_THROTTLE_MS = 6 * 60 * 60 * 1000;

/**
 * watch 自己修復の「登録試行」をスロットルすべきか判定する。祝日カレンダーなど push 通知に
 * 対応しないカレンダーは登録の度に失敗するため、同期の度に Google を叩き続けないよう
 * 6時間に1回だけ試行を許す (呼び出し側はモジュールスコープの Map で最終試行時刻を保持する
 * best-effort なスロットル — isolate 揮発は許容する)。
 */
export function shouldAttemptWatchRepair(lastAttemptMs: number | undefined, now: number): boolean {
  if (lastAttemptMs === undefined) return true;
  return now - lastAttemptMs > WATCH_REPAIR_THROTTLE_MS;
}
