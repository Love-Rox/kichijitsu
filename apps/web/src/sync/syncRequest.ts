import type { SyncRequest } from "@kichijitsu/shared";

/**
 * POST /api/sync のリクエストボディ組み立て (端末ごと syncToken、2026-07-21)。
 * deviceId (IndexedDB meta に永続化された端末識別子、db/database.ts の
 * getOrCreateDeviceId 参照) を body に含めることで、サーバー (UserSyncDO) が
 * (calendar_id, device_id) 単位で syncToken を管理できるようにする。
 * deviceId が未取得 (理論上 db より先に sync が走ることは無いはずだが念のため) の場合は
 * 省略し、サーバー側のレガシー共有トークン (全端末共有、移行期のみ) にフォールバックする。
 */
export function buildSyncRequest(
  accountId: string,
  calendarId: string,
  deviceId: string | null,
): SyncRequest {
  return deviceId ? { accountId, calendarId, deviceId } : { accountId, calendarId };
}
