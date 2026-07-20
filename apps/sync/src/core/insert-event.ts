import { GoogleApiError } from "./errors";
import type { MirrorEventBody } from "./block-reconcile";
import { insertEvent } from "../google/insert-event";

/**
 * UserSyncDO.createMirrorEvent が実装すべき依存先。core/create-event.ts の
 * CreateEventCoreDeps と同じ考え方で、DO storage / 実際の fetch を注入してロジックだけを
 * 単体テストできるようにする。
 */
export interface InsertEventCoreDeps {
  fetch: typeof fetch;
  /** キャッシュがあれば使い、無ければ (または期限切れなら) refresh_token から取り直す。 */
  getAccessToken: () => Promise<string>;
  /** キャッシュを無視して強制的にリフレッシュする (401 リトライ用)。 */
  forceRefreshAccessToken: () => Promise<string>;
}

/** `events.insert` の応答から必要なフィールドだけを写した型。 */
interface RawInsertedEvent {
  id: string;
}

/**
 * カレンダーブロック機能 (docs/blocking.md 第3段階) の mirror イベントを Google に
 * 作成する。core/create-event.ts の createEventWithRetry と同様、401 のみ 1 回だけ
 * 強制リフレッシュして同じリクエストを再試行する。403 (Workspace 非対応の
 * eventType='outOfOffice' 拒否等) や 401 リトライ後もなお失敗する場合は握りつぶさず
 * GoogleApiError として伝播させる (Workspace 判定・busy フォールバックは第4段階のスコープ、
 * ここでは呼び出し元が console.error で流すだけでよい)。
 *
 * 作成された mirror event の id を返す (block_mirrors への保存に使う)。
 */
export async function insertEventWithRetry(
  deps: InsertEventCoreDeps,
  calendarId: string,
  body: MirrorEventBody,
): Promise<string> {
  let accessToken = await deps.getAccessToken();
  let retriedAuth = false;

  for (;;) {
    const response = await insertEvent(deps.fetch, accessToken, { calendarId, body });

    if (response.status === 401 && !retriedAuth) {
      retriedAuth = true;
      accessToken = await deps.forceRefreshAccessToken();
      continue;
    }

    if (!response.ok) {
      throw new GoogleApiError(response.status, await response.text());
    }

    const created = (await response.json()) as RawInsertedEvent;
    return created.id;
  }
}
