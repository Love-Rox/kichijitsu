import type { EventCreateRequest } from "@kichijitsu/shared";
import { GoogleApiError } from "./errors";
import { createEvent, type CreateEventParams } from "../google/create-event";
import { DEFAULT_SEND_UPDATES } from "./patch-event";
import {
  isNonEmptyString,
  isOptionalBoundedString,
  MAX_DESCRIPTION_LENGTH,
  MAX_LOCATION_LENGTH,
  MAX_SUMMARY_LENGTH,
} from "./validation";

/**
 * POST /api/event/create のボディ検証 (2026-07-29 全項目入力)。core/block-rules.ts の
 * isValidBlockRuleUpsertRequest と同じ「型ガード付き純関数」の流儀で、ルートから
 * 呼んで 400 missing_fields にマップする。型定義 (EventCreateRequest) は信用せず、
 * ここで実際の値を検査する — このエンドポイントは MCP や手書きの curl からも叩ける。
 *
 * 検査するもの:
 *  - accountId / calendarId / timeZone: 非空文字列
 *  - title: 空白のみでない文字列 (Google 上で無題の予定を量産しないため) かつ長さ上限内。
 *    上限が MAX_SUMMARY_LENGTH なのは、**この `title` が Google では `summary`** だから
 *    (patch 側と同じフィールド・同じ上限。core/validation.ts のコメント参照)
 *  - startMs / endMs: 有限の数値で、**開始 < 終了** (終日も endMs は排他的な終了なので同じ不等号。
 *    web 側 validateEventEditDraft と同じ規則)
 *  - location / description: 未指定か長さ上限内の文字列
 *  - isAllDay: 未指定か boolean (文字列 "true" 等の曖昧な指定は弾く)
 */
export function isValidEventCreateRequest(body: unknown): body is EventCreateRequest {
  if (!body || typeof body !== "object") return false;
  const candidate = body as Record<string, unknown>;

  if (!isNonEmptyString(candidate.accountId)) return false;
  if (!isNonEmptyString(candidate.calendarId)) return false;
  if (!isNonEmptyString(candidate.timeZone)) return false;

  if (typeof candidate.title !== "string") return false;
  if (candidate.title.trim().length === 0) return false;
  if (candidate.title.length > MAX_SUMMARY_LENGTH) return false;

  if (typeof candidate.startMs !== "number" || !Number.isFinite(candidate.startMs)) return false;
  if (typeof candidate.endMs !== "number" || !Number.isFinite(candidate.endMs)) return false;
  if (candidate.endMs <= candidate.startMs) return false;

  if (!isOptionalBoundedString(candidate.location, MAX_LOCATION_LENGTH)) return false;
  if (!isOptionalBoundedString(candidate.description, MAX_DESCRIPTION_LENGTH)) return false;
  if (candidate.isAllDay !== undefined && typeof candidate.isAllDay !== "boolean") return false;

  return true;
}

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
 *
 * ## sendUpdates に既定値を入れる理由 (2026-07-31)
 * この経路で作る予定は**参加者を持たない** ―― CreateEventParams にも
 * EventCreateRequest (shared) にも attendees は無く、POST /api/event/create も MCP の
 * create_event も参加者を渡せない (ゲストは作成後に POST /api/event/guests で足す)。
 * したがって現状はどの値を送っても Google 側の結果は同じで、利用者に見える挙動は変わらない。
 *
 * それでも値を固定するのは、**「この層では必ず値が入る」という不変条件を破らないため**。
 * 選ぶのは kichijitsu 全体で一本の既定 (DEFAULT_SEND_UPDATES = externalOnly、
 * core/patch-event.ts のコメント参照)。将来この経路が参加者を受け取るようになっても、
 * 「利用者が明示的に選んだときだけ all」という規則の側に倒れる。
 */
export async function createEventWithRetry(
  deps: CreateEventCoreDeps,
  params: Omit<CreateEventParams, "sendUpdates">,
): Promise<string> {
  let accessToken = await deps.getAccessToken();
  let retriedAuth = false;

  for (;;) {
    const response = await createEvent(deps.fetch, accessToken, {
      ...params,
      sendUpdates: DEFAULT_SEND_UPDATES,
    });

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
