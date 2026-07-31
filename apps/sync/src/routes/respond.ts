/**
 * UserSyncDO の RPC 結果 (RpcResult) を HTTP レスポンスへ変換する共通ヘルパー。
 * routes/events.ts (POST /api/sync) と routes/calendars-tasks.ts の両方が使うため、
 * routes/api.ts の分割 (2026-07-25) にあたってどちらにも属さないこのファイルへ移した。
 *
 * ## 使う経路と、あえて使わない経路 (2026-07-31 に明文化)
 * これを使うのは**読み取り系**だけ (POST /api/sync、GET /api/calendars、GET /api/tasklists、
 * POST /api/tasks/sync) ―― Google の実 status をそのままクライアントへ返してよい経路。
 *
 * **書き戻し系 (patch/rsvp/guests/create/delete、task/patch) は意図的に使わない**。
 * これらは失敗理由を一律 409 (rsvp の not_an_attendee とゲスト編集の not_organizer だけ 422) に
 * マップする設計で、クライアントに理由ごとの分岐を要求しない (routes/events.ts の冒頭コメント)。
 * ここで respondFromRpcResult に揃えると Google 由来の 404/403/412/429/5xx がそのまま外に出て、
 * **「反映できなかった」以上のことをクライアントが解釈しなければならなくなる** ―― 揃っていない
 * のは書き忘れではなく、この方針の現れ。
 *
 * routes/settings.ts がこれを import していないのも同じ理由ではなく単に**該当が無い**から:
 * あのファイルで RpcResult を受けるのは連携解除の後始末 (clearSyncState) とミラー掃除だけで、
 * どちらも結果をクライアントへ返さない (ログに出す / 例外にする)。
 */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiError } from "@kichijitsu/shared";
import type { AppEnv } from "../types";
import type { RpcResult } from "../rpc-result";

export function respondFromRpcResult<T>(c: Context<AppEnv>, result: RpcResult<T>) {
  if (result.ok) {
    return c.json(result.data);
  }
  // RpcResult.status は Google/内部エラーに由来する実 HTTP ステータス (401/403/404/410/429/5xx など)。
  // 1xx や 204/304 のような「本文なし」コードにはならない。
  return c.json<ApiError>({ error: result.error }, result.status as ContentfulStatusCode);
}
