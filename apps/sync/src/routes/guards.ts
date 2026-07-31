/**
 * ルートの入り口で必ず通る2つの定型 ―― **ボディの JSON パース**と**対象アカウントの
 * 所属検証** ―― を1箇所に集めたもの (2026-07-31)。
 *
 * 集めた理由は行数ではなく**取り違えの防止**にある: 所属検証は
 * 「`SELECT profile_id FROM accounts WHERE id = ?` → isAccountInProfile → 403」の6行が
 * events/settings/calendars-tasks に **12箇所**まったく同じ形で並んでおり、1箇所だけ
 * 条件を書き間違えても目視では気付けない。これは他人のカレンダーに触れるかどうかを
 * 決める検査なので、実装は1つだけにしておきたい。
 *
 * **エラーの中身はルート側に残す方針**にしてある ―― 判定だけをここに出し、
 * 「どのエラー文字列でどのステータスを返すか」はルートの読み手に見えるようにする
 * (ここに畳んでしまうと、ルートを読んでも何が返るのか分からなくなる)。
 * 唯一 403 account_not_found だけは12箇所で完全に同一なのでレスポンスごと返す。
 *
 * 認証 (requireAuth) 自体はここではなく middleware.ts にあり、その適用漏れは
 * test/api-auth.test.ts が全ルート列挙で機械的に検査している。
 */
import type { Context } from "hono";
import type { ApiError } from "@kichijitsu/shared";
import type { AppEnv } from "../types";
import { isAccountInProfile } from "../accounts";

/**
 * `readJsonBody` が「ボディが JSON として壊れている」ことを表す値。
 *
 * `null` や `undefined` を使わない理由: `JSON.parse("null")` は成功して `null` を返すため、
 * それらでは「壊れている」と「本文が `null` だった」を区別できない。区別できないと、
 * 従来 `missing_fields` になっていた `null` ボディが `invalid_json` に化ける
 * (どちらも 400 だが、クライアントに見えるエラー文字列が変わる)。
 */
export const INVALID_JSON = Symbol("invalid_json");

/**
 * リクエストボディを JSON として読む。壊れていれば INVALID_JSON を返す。
 *
 * 400 を返すのは呼び出し側のルート:
 * ```ts
 * const body = await readJsonBody<SyncRequest>(c);
 * if (body === INVALID_JSON) return c.json<ApiError>({ error: "invalid_json" }, 400);
 * ```
 * 型引数はこれまでルートが `c.req.json<T>()` に渡していたものをそのまま引き継ぐ ――
 * つまり**中身は検査していない**ので、`unknown` を指定して型ガード付きの検証関数
 * (core/*.ts の isValid*Request) に渡すのがこの後の作法。
 */
export async function readJsonBody<T>(c: Context<AppEnv>): Promise<T | typeof INVALID_JSON> {
  try {
    return await c.req.json<T>();
  } catch {
    return INVALID_JSON;
  }
}

/**
 * 対象アカウントがこのリクエストのプロファイルに属しているかを検証する。
 * 属していなければ **403 account_not_found のレスポンス**を、通ってよければ `null` を返す。
 *
 * ```ts
 * const denied = await denyUnlessAccountInProfile(c, body.accountId);
 * if (denied) return denied;
 * ```
 *
 * 存在しない accountId と「他人のプロファイルの accountId」を区別せず同じ 403 にする
 * (アカウントの存在有無を漏らさないため)。この方針は block_rules / mcp_tokens 側の
 * 同種の検査 (routes/settings.ts) とも揃えてある。
 *
 * profileId は requireAuth を通った後なので必ず入っている。
 */
export async function denyUnlessAccountInProfile(
  c: Context<AppEnv>,
  accountId: string,
): Promise<Response | null> {
  const profileId = c.get("profileId")!;
  const account = await c.env.DB.prepare("SELECT profile_id FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ profile_id: string }>();
  if (isAccountInProfile(account, profileId)) return null;
  return c.json<ApiError>({ error: "account_not_found" }, 403);
}
