/**
 * カレンダー一覧と Google タスクの `/api/calendars`・`/api/tasklists`・`/api/tasks/sync`・
 * `/api/task/patch` (docs/google-tasks.md)。routes/api.ts から分割 (2026-07-25) — 挙動は
 * 変えていない。
 *
 * いずれも UserSyncDO への RPC 委譲 + 対象アカウントの所属検証 (isAccountInProfile) が骨格。
 * 読み取り系のエラーは respondFromRpcResult で実 status のまま返し、書き戻し (task/patch) だけは
 * /api/event/patch と同じ一律 409 にマップする。
 */
import { Hono } from "hono";
import type {
  ApiError,
  TaskListsResponse,
  TaskPatchRequest,
  TaskPatchResponse,
  TasksSyncRequest,
  TasksSyncResponse,
} from "@kichijitsu/shared";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware";
import { isAccountInProfile } from "../accounts";
import { respondFromRpcResult } from "./respond";

export const calendarsTasksRoutes = new Hono<AppEnv>();

calendarsTasksRoutes.get("/api/calendars", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  const accountId = c.req.query("accountId");
  if (!accountId) {
    return c.json<ApiError>({ error: "missing_accountId" }, 400);
  }

  const account = await c.env.DB.prepare("SELECT profile_id FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ profile_id: string }>();
  if (!isAccountInProfile(account, profileId)) {
    // 存在しない accountId と「他人のプロファイルの accountId」を区別せず 403 にする
    // (存在有無を漏らさないため)。
    return c.json<ApiError>({ error: "account_not_found" }, 403);
  }

  const stub = c.env.USER_SYNC.getByName(accountId);
  const result = await stub.listCalendars(accountId);
  return respondFromRpcResult(c, result);
});

// Google タスク連携 (docs/google-tasks.md、2026-07-20): アカウントのタスクリスト一覧。
// tasks はオプションスコープ (hasRequiredScopes には含めない) なので、未付与のユーザーは
// ここで初めて Google から 403 を受け取る。その 403 を tasks_scope_missing に変換して
// 返す (D1 にスコープを保存していないので、実際に叩いてみて判定する最小実装 —
// google/oauth.ts の hasTasksScope のコメント参照)。それ以外のエラーは通常どおり
// respondFromRpcResult で実 status のまま返す。
calendarsTasksRoutes.get("/api/tasklists", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  const accountId = c.req.query("accountId");
  if (!accountId) {
    return c.json<ApiError>({ error: "missing_accountId" }, 400);
  }

  const account = await c.env.DB.prepare("SELECT profile_id FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ profile_id: string }>();
  if (!isAccountInProfile(account, profileId)) {
    return c.json<ApiError>({ error: "account_not_found" }, 403);
  }

  const stub = c.env.USER_SYNC.getByName(accountId);
  const result = await stub.listTaskLists(accountId);
  if (!result.ok && result.status === 403) {
    return c.json<ApiError>({ error: "tasks_scope_missing" }, 403);
  }
  if (!result.ok) {
    return respondFromRpcResult(c, result);
  }
  return c.json<TaskListsResponse>({ taskLists: result.data });
});

// 指定タスクリストの全タスクを取得する (Tasks API に syncToken は無いので毎回全件、
// design 参照)。エラーは respondFromRpcResult で実 status のまま返す (GET /api/calendars
// や POST /api/sync と同じ流儀)。
calendarsTasksRoutes.post("/api/tasks/sync", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  let body: TasksSyncRequest;
  try {
    body = await c.req.json<TasksSyncRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (!body?.accountId || !body?.taskListId) {
    return c.json<ApiError>({ error: "missing_accountId_or_taskListId" }, 400);
  }

  const account = await c.env.DB.prepare("SELECT profile_id FROM accounts WHERE id = ?")
    .bind(body.accountId)
    .first<{ profile_id: string }>();
  if (!isAccountInProfile(account, profileId)) {
    return c.json<ApiError>({ error: "account_not_found" }, 403);
  }

  const stub = c.env.USER_SYNC.getByName(body.accountId);
  const result = await stub.syncTasks(body.accountId, body.taskListId);
  if (!result.ok) {
    return respondFromRpcResult(c, result);
  }
  return c.json<TasksSyncResponse>({ tasks: result.data });
});

// タスクの完了状態変更を Google へ書き戻す。エラーの一律 409 マッピング方針は
// /api/event/patch と同じ (コメント参照) — 正本は次の /api/tasks/sync 再取得で還流する。
calendarsTasksRoutes.post("/api/task/patch", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  let body: TaskPatchRequest;
  try {
    body = await c.req.json<TaskPatchRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (
    !body?.accountId ||
    !body?.taskListId ||
    !body?.taskId ||
    (body.status !== "needsAction" && body.status !== "completed")
  ) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  const account = await c.env.DB.prepare("SELECT profile_id FROM accounts WHERE id = ?")
    .bind(body.accountId)
    .first<{ profile_id: string }>();
  if (!isAccountInProfile(account, profileId)) {
    return c.json<ApiError>({ error: "account_not_found" }, 403);
  }

  const stub = c.env.USER_SYNC.getByName(body.accountId);
  const result = await stub.patchTask(body.accountId, body.taskListId, body.taskId, body.status);
  if (!result.ok) {
    console.warn(
      `task patch failed: account=${body.accountId} taskList=${body.taskListId} task=${body.taskId} status=${result.status} error=${result.error}`,
    );
    return c.json<ApiError>({ error: "patch_failed" }, 409);
  }

  return c.json<TaskPatchResponse>({ ok: true });
});
