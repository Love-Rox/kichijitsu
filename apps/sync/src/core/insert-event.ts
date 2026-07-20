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
 * カレンダーブロック機能 (docs/blocking.md 第4段階) の mirror イベントを Google に
 * 作成する。core/create-event.ts の createEventWithRetry と同様、401 のみ 1 回だけ
 * 強制リフレッシュして同じリクエストを再試行する (この 401 リトライは OOO フォールバックと
 * 独立した関心事であり、フォールバック試行そのものには重ねて適用しない — フォールバック
 * リクエストが 401 になるのは稀な edge case であり、その場合は素直に GoogleApiError にする)。
 *
 * 加えて第4段階として: body が `eventType: 'outOfOffice'` を含み、(401 リトライ後の)
 * 応答が 400 か 403 (Workspace 非対応でこの eventType を拒否された場合等) のときに限り、
 * `eventType` を除いた body で 1 回だけ busy として再試行する。このフォールバック再試行が
 * 成功すれば `{ id, oooFallback: true }` を返す。フォールバック再試行自体が失敗した場合は
 * 握りつぶさず GoogleApiError を投げる。OOO 以外の body の失敗や、OOO body でも 400/403
 * 以外の失敗 (例: 429) は今まで通りフォールバックせず即座に GoogleApiError を投げる。
 *
 * 作成された mirror event の id を返す (block_mirrors への保存に使う)。
 */
export async function insertEventWithRetry(
  deps: InsertEventCoreDeps,
  calendarId: string,
  body: MirrorEventBody,
): Promise<{ id: string; oooFallback: boolean }> {
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
      if (
        body.eventType === "outOfOffice" &&
        (response.status === 400 || response.status === 403)
      ) {
        const { eventType: _eventType, ...fallbackBody } = body;
        const fallbackResponse = await insertEvent(deps.fetch, accessToken, {
          calendarId,
          body: fallbackBody,
        });
        if (!fallbackResponse.ok) {
          throw new GoogleApiError(fallbackResponse.status, await fallbackResponse.text());
        }
        const created = (await fallbackResponse.json()) as RawInsertedEvent;
        return { id: created.id, oooFallback: true };
      }
      throw new GoogleApiError(response.status, await response.text());
    }

    const created = (await response.json()) as RawInsertedEvent;
    return { id: created.id, oooFallback: false };
  }
}
