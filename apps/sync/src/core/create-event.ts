import type { EventCreateRequest } from "@kichijitsu/shared";
import { GoogleApiError } from "./errors";
import { createEvent, type CreateEventParams } from "../google/create-event";

/**
 * POST /api/event/create のボディ検証で使う上限 (2026-07-29 全項目入力)。
 * description は Google Calendar API の上限 8192 文字に合わせる。summary/location は
 * 明記された上限が無いため、UI の1行入力として現実的な 1024 文字で切る
 * (無制限に受けて Google 側で 400 になるより、こちらで理由の分かる 400 を返す)。
 */
const MAX_TITLE_LENGTH = 1024;
const MAX_LOCATION_LENGTH = 1024;
const MAX_DESCRIPTION_LENGTH = 8192;

/** 非空文字列か (accountId/calendarId/timeZone 用。block-rules.ts の isValidCalendarRef と同じ流儀) */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 未指定 (undefined) か、maxLength 以内の文字列か */
function isOptionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= maxLength);
}

/**
 * POST /api/event/create のボディ検証 (2026-07-29 全項目入力)。core/block-rules.ts の
 * isValidBlockRuleUpsertRequest と同じ「型ガード付き純関数」の流儀で、ルートから
 * 呼んで 400 missing_fields にマップする。型定義 (EventCreateRequest) は信用せず、
 * ここで実際の値を検査する — このエンドポイントは MCP や手書きの curl からも叩ける。
 *
 * 検査するもの:
 *  - accountId / calendarId / timeZone: 非空文字列
 *  - title: 空白のみでない文字列 (Google 上で無題の予定を量産しないため) かつ長さ上限内
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
  if (candidate.title.length > MAX_TITLE_LENGTH) return false;

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
