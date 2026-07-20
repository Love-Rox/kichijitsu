import { GoogleApiError } from "./errors";
import { createEvent, type CreateEventParams } from "../google/create-event";

/**
 * UserSyncDO.createEvent が実装すべき依存先。core/patch-event.ts の PatchEventCoreDeps と
 * 同じ考え方で、DO storage / 実際の fetch を注入してロジックだけを単体テストできるようにする。
 */
export interface CreateEventCoreDeps {
  fetch: typeof fetch;
  /** キャッシュがあれば使い、無ければ (または期限切れなら) refresh_token から取り直す。 */
  getAccessToken: () => Promise<string>;
  /** キャッシュを無視して強制的にリフレッシュする (401 リトライ用)。 */
  forceRefreshAccessToken: () => Promise<string>;
}

/** `events.insert` の応答から必要なフィールドだけを写した型。 */
interface RawCreatedEvent {
  id: string;
}

/**
 * 新規予定を Google Calendar に作成する。core/patch-event.ts の patchEventTimeWithRetry と
 * 同様、401 のみ 1 回だけ強制リフレッシュして同じリクエストを再試行する。403/412/5xx や
 * 401 リトライ後もなお失敗する場合は握りつぶさず GoogleApiError として伝播させる —
 * 呼び出し元 (route) がこれを 409 create_failed 等にマップし、クライアントに楽観更新の
 * ロールバックを促す。
 *
 * 作成された event の id を返す (UI が楽観的 occurrence の id を確定 id に差し替えるため)。
 * それ以外の作成結果 (実際の start/end 等) を正本として扱うことはしない — 正本は次の同期
 * (Google からの webhook/ポーリング → SSE 'changed' → クライアントの /api/sync) で還流する。
 */
export async function createEventWithRetry(
  deps: CreateEventCoreDeps,
  params: CreateEventParams,
): Promise<string> {
  let accessToken = await deps.getAccessToken();
  let retriedAuth = false;

  for (;;) {
    const response = await createEvent(deps.fetch, accessToken, params);

    if (response.status === 401 && !retriedAuth) {
      retriedAuth = true;
      accessToken = await deps.forceRefreshAccessToken();
      continue;
    }

    if (!response.ok) {
      throw new GoogleApiError(response.status, await response.text());
    }

    const created = (await response.json()) as RawCreatedEvent;
    return created.id;
  }
}
