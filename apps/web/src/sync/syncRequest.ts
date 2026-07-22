import type { SyncRequest } from "@kichijitsu/shared";

/**
 * POST /api/sync のリクエストボディ組み立て (端末ごと syncToken、2026-07-21)。
 * deviceId (IndexedDB meta に永続化された端末識別子、db/database.ts の
 * getOrCreateDeviceId 参照) を body に含めることで、サーバー (UserSyncDO) が
 * (calendar_id, device_id) 単位で syncToken を管理できるようにする。
 * deviceId が未取得 (理論上 db より先に sync が走ることは無いはずだが念のため) の場合は
 * 省略し、サーバー側のレガシー共有トークン (全端末共有、移行期のみ) にフォールバックする。
 *
 * forceFull (2026-07-22、eventType 一度きりバックフィル用、App.tsx の
 * runOooBackfillIfNeeded 参照): true のときのみ body に含める。省略時 (デフォルト false) は
 * キー自体を付けない — SyncRequest.forceFull は optional でサーバー側も未指定を
 * 「forceFull ではない」として扱うため実害は無いが、通常の同期リクエストのペイロードを
 * 従来どおり最小に保つ。
 */
export function buildSyncRequest(
  accountId: string,
  calendarId: string,
  deviceId: string | null,
  forceFull = false,
): SyncRequest {
  return {
    accountId,
    calendarId,
    ...(deviceId ? { deviceId } : {}),
    ...(forceFull ? { forceFull: true } : {}),
  };
}
