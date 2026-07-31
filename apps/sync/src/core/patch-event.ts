import type { EventPatchRequest, EventSendUpdates } from "@kichijitsu/shared";
import { GoogleApiError } from "./errors";
import { patchEventTime, type PatchEventTimeParams } from "../google/patch-event";

/**
 * クライアントから送ってよい sendUpdates。`none` は含めない (shared の EventSendUpdates 参照)。
 * 削除の検証 (core/delete-event.ts の isValidEventDeleteRequest) も**これを import して使う**
 * ―― 更新と削除で通す値の集合を別々に書くと、片方だけ `none` が通る日が来るため。
 */
export const SEND_UPDATES_VALUES: readonly string[] = ["all", "externalOnly"];

/**
 * リクエストが sendUpdates を持たないときに補う値 (2026-07-31)。
 *
 * `externalOnly` にする理由は shared の EventSendUpdates のコメントのとおり ――
 * **頼まれてもいないメールを Google カレンダーのゲストに出さない**かつ
 * **外部カレンダーのゲストを古い時刻のまま放置しない**を同時に満たす唯一の値だから。
 * ここに来るのは (1) sendUpdates を知らない旧クライアント、(2) MCP の update_event の
 * ように問いかける相手がいない経路 ―― どちらも「利用者が明示的に全員へ知らせると
 * 言った」わけではないので、`all` を既定にはしない。
 *
 * **削除 (core/delete-event.ts、user-sync-do.ts の deleteEvent) も同じ既定を使う**
 * (2026-07-31)。削除は取り消せない操作なので `all` に倒したくなるが、それをすると
 * 「訊いてもいない経路 (MCP の delete_event、ブロック機能のミラー掃除) が勝手に
 * 全員へキャンセルメールを出す」ことになる ―― 規則は更新と同じ一本、
 * **利用者が明示的に選んだときだけ `all`** にしてある。
 */
export const DEFAULT_SEND_UPDATES: EventSendUpdates = "externalOnly";

/**
 * 送られてきた sendUpdates を、Google に渡す確定値へ解決する純関数。
 * **未指定を Google の未文書の既定に落とさない**ための、たった1行の砦
 * (google/patch-event.ts の PatchEventTimeParams.sendUpdates、google/delete-event.ts の
 * DeleteEventParams.sendUpdates が必須なのと対になる)。更新も削除もこの1つを通る。
 */
export function resolveSendUpdates(requested: EventSendUpdates | undefined): EventSendUpdates {
  return requested ?? DEFAULT_SEND_UPDATES;
}

/**
 * POST /api/event/patch のボディ検証で使う上限。core/create-event.ts の同名定数と同じ根拠
 * (description は Google Calendar API の上限 8192、summary/location は UI の1行入力として
 * 現実的な 1024 で切る)。
 */
const MAX_SUMMARY_LENGTH = 1024;
const MAX_LOCATION_LENGTH = 1024;
const MAX_DESCRIPTION_LENGTH = 8192;

/** 非空文字列か (core/create-event.ts の同名関数と同じ) */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 未指定 (undefined) か、maxLength 以内の文字列か */
function isOptionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= maxLength);
}

/**
 * POST /api/event/patch のボディ検証 (2026-07-30)。それまでルートにインラインで書かれていた
 * 条件式を、core/create-event.ts の isValidEventCreateRequest と同じ「型ガード付き純関数」に
 * 出したもの ―― **startMs/endMs が optional になった**ことで検査が「両方指定 or 両方省略」の
 * 組み合わせ判定を含むようになり、インラインでは読めなくなったため。
 *
 * なぜ組み合わせを弾くのか: 片方だけ届いたリクエストをそのまま Google に流すと、
 * `start` だけ・`end` だけを持つ PATCH になる。events.patch は指定したフィールドだけを
 * マージするので、**開始だけが動いて終了が据え置かれた予定** (長さがめちゃくちゃになった
 * 予定、あるいは終了 < 開始で Google に 400 で弾かれる予定) が出来上がる。ここで 400 に
 * 落として、意味の分かるエラーをクライアントへ返す。
 *
 * 検査するもの:
 *  - accountId / calendarId / eventId / timeZone: 非空文字列
 *  - startMs / endMs: **両方 undefined** (時刻を触らない) か、**両方が有限の数値で開始 < 終了**
 *  - summary / location / description: 未指定か長さ上限内の文字列 (空文字は「クリア」なので許す)
 *  - isAllDay: 未指定か boolean (文字列 "true" 等の曖昧な指定は弾く)
 *  - sendUpdates: 未指定か "all" / "externalOnly" (2026-07-31)。**"none" は弾く** ――
 *    Google の enum には在るが kichijitsu は使わない値で、通してしまうと外部ゲストの
 *    カレンダーだけが古いまま残る (shared の EventSendUpdates のコメント参照)。
 *    未指定は resolveSendUpdates が既定を補うので 400 にはしない (旧クライアント互換)。
 */
export function isValidEventPatchRequest(body: unknown): body is EventPatchRequest {
  if (!body || typeof body !== "object") return false;
  const candidate = body as Record<string, unknown>;

  if (!isNonEmptyString(candidate.accountId)) return false;
  if (!isNonEmptyString(candidate.calendarId)) return false;
  if (!isNonEmptyString(candidate.eventId)) return false;
  if (!isNonEmptyString(candidate.timeZone)) return false;

  const hasStart = candidate.startMs !== undefined;
  const hasEnd = candidate.endMs !== undefined;
  if (hasStart !== hasEnd) return false;
  if (hasStart) {
    if (typeof candidate.startMs !== "number" || !Number.isFinite(candidate.startMs)) return false;
    if (typeof candidate.endMs !== "number" || !Number.isFinite(candidate.endMs)) return false;
    if (candidate.endMs <= candidate.startMs) return false;
  }

  if (!isOptionalBoundedString(candidate.summary, MAX_SUMMARY_LENGTH)) return false;
  if (!isOptionalBoundedString(candidate.location, MAX_LOCATION_LENGTH)) return false;
  if (!isOptionalBoundedString(candidate.description, MAX_DESCRIPTION_LENGTH)) return false;
  if (candidate.isAllDay !== undefined && typeof candidate.isAllDay !== "boolean") return false;
  if (
    candidate.sendUpdates !== undefined &&
    !SEND_UPDATES_VALUES.includes(candidate.sendUpdates as string)
  ) {
    return false;
  }

  return true;
}

/**
 * UserSyncDO.patchEvent が実装すべき依存先。sync.ts の SyncCoreDeps と同じ考え方で、
 * DO storage / 実際の fetch を注入してロジックだけを単体テストできるようにする。
 */
export interface PatchEventCoreDeps {
  fetch: typeof fetch;
  /** キャッシュがあれば使い、無ければ (または期限切れなら) refresh_token から取り直す。 */
  getAccessToken: () => Promise<string>;
  /** キャッシュを無視して強制的にリフレッシュする (401 リトライ用)。 */
  forceRefreshAccessToken: () => Promise<string>;
}

/**
 * 予定の変更 (時刻 + 2026-07-22 以降は summary/location/description/isAllDay も可) を
 * Google へ書き戻す。sync.ts の runSync と同様、401 のみ 1 回だけ強制リフレッシュして
 * 同じリクエストを再試行する。404 (イベントなし) / 403 / 412 (前提条件の不一致) や
 * 401 リトライ後もなお失敗する場合は握りつぶさず GoogleApiError として伝播させる —
 * 呼び出し元 (route) がこれを 409 patch_failed 等にマップし、クライアントに楽観更新の
 * ロールバックを促す。
 *
 * params の summary/location/description/isAllDay の扱いは google/patch-event.ts の
 * patchEventTime のコメント参照 (指定したフィールドのみ PATCH body に含める)。
 *
 * 書き込みが成功しても戻り値は無い (void)。正本は次の同期 (Google からの
 * webhook/ポーリング → SSE 'changed' → クライアントの /api/sync) で還流する設計であり、
 * ここで Google の応答ボディを整形してクライアントへ返すことはしない。
 */
export async function patchEventTimeWithRetry(
  deps: PatchEventCoreDeps,
  params: PatchEventTimeParams,
): Promise<void> {
  let accessToken = await deps.getAccessToken();
  let retriedAuth = false;

  for (;;) {
    const response = await patchEventTime(deps.fetch, accessToken, params);

    if (response.status === 401 && !retriedAuth) {
      retriedAuth = true;
      accessToken = await deps.forceRefreshAccessToken();
      continue;
    }

    if (!response.ok) {
      throw new GoogleApiError(response.status, await response.text());
    }

    return;
  }
}
