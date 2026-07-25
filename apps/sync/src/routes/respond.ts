/**
 * UserSyncDO の RPC 結果 (RpcResult) を HTTP レスポンスへ変換する共通ヘルパー。
 * routes/events.ts (POST /api/sync) と routes/calendars-tasks.ts の両方が使うため、
 * routes/api.ts の分割 (2026-07-25) にあたってどちらにも属さないこのファイルへ移した。
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
