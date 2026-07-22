import { GoogleApiError, NotAnAttendeeError, NotConnectedError } from "./core/errors";

/**
 * Durable Object の RPC メソッドは、カスタム Error サブクラスをそのまま throw しても
 * RPC 境界を越える際に instanceof が保持される保証がない (構造化クローンで
 * 再構築されるため)。そのため呼び出し元 (Hono ルート) が確実に分岐できるよう、
 * 判別可能なプレーンオブジェクトとして結果を返す。
 */
export type RpcResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export async function runRpc<T>(fn: () => Promise<T>): Promise<RpcResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (err instanceof NotConnectedError) {
      return { ok: false, status: 401, error: "not_connected" };
    }
    if (err instanceof NotAnAttendeeError) {
      // RSVP (2026-07-22): self attendee が無い予定への RSVP 試行。route 側 (POST
      // /api/event/rsvp) はこの error 文字列で判定し、他の失敗 (409) と区別して 422 で返す。
      return { ok: false, status: 422, error: "not_an_attendee" };
    }
    if (err instanceof GoogleApiError) {
      return { ok: false, status: err.status, error: err.message };
    }
    console.error("UserSyncDO RPC error", err);
    return { ok: false, status: 500, error: "internal_error" };
  }
}
