import { Hono, type Context } from "hono";
import { deleteCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type {
  AccountDTO,
  ApiError,
  BlockRuleDeleteRequest,
  BlockRuleDTO,
  BlockRulesResponse,
  BlockRuleUpsertRequest,
  DisconnectRequest,
  EventCreateRequest,
  EventCreateResponse,
  EventDeleteRequest,
  EventDeleteResponse,
  EventPatchRequest,
  EventPatchResponse,
  GitHubItemsResponse,
  MeResponse,
  SyncRequest,
  TaskListsResponse,
  TaskPatchRequest,
  TaskPatchResponse,
  TasksSyncRequest,
  TasksSyncResponse,
  VisibleCalendarsRequest,
  WatchRequest,
} from "@kichijitsu/shared";
import type { AppEnv } from "../types";
import { populateProfileId, requireAuth } from "../middleware";
import { SESSION_COOKIE_NAME } from "../session";
import { decryptToken, InvalidCiphertextError } from "../crypto";
import { revokeToken } from "../google/oauth";
import { fetchGitHubItems } from "../core/github-items";
import { GitHubApiError } from "../github/http";
import { registerWatch, stopWatch, buildWebhookAddress } from "../google/watch";
import {
  isAccountInProfile,
  resolveDisconnectTargets,
  shouldClearSessionAfterDisconnect,
  type AccountMembership,
} from "../accounts";
import { buildWatchRow } from "../core/watch-service";
import {
  aggregateVisibleCalendars,
  buildCalendarPrefsRow,
  buildVisibleCalendarRows,
  isValidVisibleCalendarsRequest,
} from "../core/visible-calendars";
import {
  aggregateBlockRules,
  buildBlockRuleRows,
  collectReferencedAccountIds,
  isValidBlockRuleDeleteRequest,
  isValidBlockRuleUpsertRequest,
  type BlockRuleRow,
} from "../core/block-rules";
import { computeChannelToken } from "../watch-token";
import { PROFILE_ID_HEADER } from "../durable-object/profile-hub-do";
import type { RpcResult } from "../rpc-result";

export const apiRoutes = new Hono<AppEnv>();

interface WatchApiResponse {
  watching: boolean;
}

apiRoutes.use("*", populateProfileId);

apiRoutes.get("/api/me", async (c) => {
  const profileId = c.get("profileId");
  if (!profileId) {
    return c.json<MeResponse>({
      connected: false,
      accounts: [],
      visibleCalendars: {},
      github: null,
    });
  }
  const { results } = await c.env.DB.prepare(
    "SELECT id, email FROM accounts WHERE profile_id = ? ORDER BY created_at ASC",
  )
    .bind(profileId)
    .all<{ id: string; email: string }>();
  const accounts: AccountDTO[] = results.map((row) => ({ id: row.id, email: row.email }));
  const visibleCalendars = await loadVisibleCalendars(
    c.env,
    accounts.map((account) => account.id),
  );
  const github = await loadGitHubConnection(c.env, profileId);
  return c.json<MeResponse>({ connected: accounts.length > 0, accounts, visibleCalendars, github });
});

// GitHub 連携解除 (docs/github-oauth.md、2026-07-20)。issue/PR 同期は次フェーズなので、
// ここでは github_connections の行を消すだけ (Google の revoke 相当は無い — GitHub App の
// user-to-server トークンは App 側の Installations 画面から取り消す運用を想定)。
apiRoutes.delete("/api/github", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  await c.env.DB.prepare("DELETE FROM github_connections WHERE profile_id = ?")
    .bind(profileId)
    .run();
  return c.body(null, 204);
});

// GitHub アイテム取得 (docs/github-integration.md フェーズ①、2026-07-20)。milestone 期日 +
// その milestone の open issue/PR を取って DTO で返すだけ (サーバーは永続化しない、
// Google の /api/sync と同じ思想)。表示 (専用レーン) は Part B で別途。
// - 未連携 (github_connections に行が無い) は 409 github_not_connected。
// - 復号できない/GitHub が 401 を返す (トークン失効) は 401 github_auth_expired
//   (将来の再連携導線用に区別しておく)。
// - それ以外の GitHub API 失敗は一律 502 github_fetch_failed (/api/event/patch 等の
//   一律マッピング方針と同じ — 理由ごとの分岐をクライアントに要求しない)。
apiRoutes.get("/api/github/items", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;

  const connection = await c.env.DB.prepare(
    "SELECT access_token FROM github_connections WHERE profile_id = ?",
  )
    .bind(profileId)
    .first<{ access_token: string }>();
  if (!connection) {
    return c.json<ApiError>({ error: "github_not_connected" }, 409);
  }

  let accessToken: string;
  try {
    accessToken = await decryptToken(c.env.TOKEN_ENC_KEY, connection.access_token);
  } catch (err) {
    if (!(err instanceof InvalidCiphertextError)) throw err;
    console.warn(`github items: could not decrypt access_token for profile ${profileId}`);
    return c.json<ApiError>({ error: "github_auth_expired" }, 401);
  }

  try {
    const items = await fetchGitHubItems({ fetch, token: accessToken });
    return c.json<GitHubItemsResponse>({ items });
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 401) {
      console.warn(`github items: GitHub rejected the access token for profile ${profileId}`);
      return c.json<ApiError>({ error: "github_auth_expired" }, 401);
    }
    console.error(`github items: fetch failed for profile ${profileId}`, err);
    return c.json<ApiError>({ error: "github_fetch_failed" }, 502);
  }
});

// カレンダー選択をサーバーに保存する (2026-07-20、端末間同期)。対象アカウントの所属検証あり。
// 1アカウントぶんを DELETE→INSERT の全置換で書き込み、あわせて account_calendar_prefs に
// configured=1 を upsert する (「未設定」と「空選択」を区別するためのフラグ。詳細は
// migrations/0005_visible_calendars.sql と core/visible-calendars.ts のコメント参照)。
// D1 の batch は暗黙のトランザクションとして実行される。
apiRoutes.put("/api/visible-calendars", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  let body: VisibleCalendarsRequest;
  try {
    body = await c.req.json<VisibleCalendarsRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (!isValidVisibleCalendarsRequest(body)) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  const account = await c.env.DB.prepare("SELECT profile_id FROM accounts WHERE id = ?")
    .bind(body.accountId)
    .first<{ profile_id: string }>();
  if (!isAccountInProfile(account, profileId)) {
    return c.json<ApiError>({ error: "account_not_found" }, 403);
  }

  const now = Date.now();
  const rows = buildVisibleCalendarRows(body.accountId, body.calendarIds, now);
  const prefsRow = buildCalendarPrefsRow(body.accountId, now);

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM account_visible_calendars WHERE account_id = ?").bind(
      body.accountId,
    ),
    ...rows.map((row) =>
      c.env.DB.prepare(
        "INSERT INTO account_visible_calendars (account_id, calendar_id, created_at) VALUES (?, ?, ?)",
      ).bind(row.account_id, row.calendar_id, row.created_at),
    ),
    c.env.DB.prepare(
      `INSERT INTO account_calendar_prefs (account_id, configured, updated_at) VALUES (?, 1, ?)
       ON CONFLICT(account_id) DO UPDATE SET configured = 1, updated_at = excluded.updated_at`,
    ).bind(prefsRow.account_id, prefsRow.updated_at),
  ]);

  return c.body(null, 204);
});

// カレンダーブロック機能 第1段階 (docs/blocking.md、2026-07-20): block_rules の CRUD のみ。
// リコンサイル (mirror 生成) は第2段階で別途実装する。
apiRoutes.get("/api/block-rules", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  const rules = await loadBlockRules(c.env, profileId);
  return c.json<BlockRulesResponse>({ rules });
});

// id 無し=新規作成 (crypto.randomUUID() でルート側が採番)、id 有り=更新 (全置換: 該当行の
// UPDATE + block_rule_sources の DELETE→INSERT)。source/target の全 accountId がこの
// プロファイルに属していることを検証する (他人のアカウントを参照させない)。D1 の batch は
// 暗黙のトランザクションとして実行される。
apiRoutes.post("/api/block-rules", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  let body: BlockRuleUpsertRequest;
  try {
    body = await c.req.json<BlockRuleUpsertRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (!isValidBlockRuleUpsertRequest(body)) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  const referencedAccountIds = Array.from(collectReferencedAccountIds(body));
  if (!(await accountsAllBelongToProfile(c.env, referencedAccountIds, profileId))) {
    return c.json<ApiError>({ error: "account_not_found" }, 403);
  }

  // 更新の場合、既存行の ooo_fallback を保持してレスポンスに反映するため取得しておく
  // (下の INSERT ... ON CONFLICT は ooo_fallback を SET しないため DB 上の値は変わらない —
  // 新規に既に記録されたフラグを更新の度に false へ巻き戻さないための意図的な仕様)。
  let existingOooFallback = false;
  if (body.id) {
    const existing = await c.env.DB.prepare(
      "SELECT profile_id, ooo_fallback FROM block_rules WHERE id = ?",
    )
      .bind(body.id)
      .first<{ profile_id: string; ooo_fallback: number }>();
    if (!isAccountInProfile(existing, profileId)) {
      // 存在しない id と「他人のプロファイルの id」を区別せず 403 にする (他のエンドポイントと同じ方針)。
      return c.json<ApiError>({ error: "rule_not_found" }, 403);
    }
    existingOooFallback = existing?.ooo_fallback === 1;
  }

  const ruleId = body.id ?? crypto.randomUUID();
  const now = Date.now();
  const { ruleRow, sourceRows } = buildBlockRuleRows(ruleId, profileId, body, now);

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO block_rules (id, profile_id, target_account_id, target_calendar_id, mode, created_at, ooo_fallback)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         target_account_id = excluded.target_account_id,
         target_calendar_id = excluded.target_calendar_id,
         mode = excluded.mode`,
    ).bind(
      ruleRow.id,
      ruleRow.profile_id,
      ruleRow.target_account_id,
      ruleRow.target_calendar_id,
      ruleRow.mode,
      ruleRow.created_at,
      ruleRow.ooo_fallback,
    ),
    c.env.DB.prepare("DELETE FROM block_rule_sources WHERE rule_id = ?").bind(ruleId),
    ...sourceRows.map((row) =>
      c.env.DB.prepare(
        "INSERT INTO block_rule_sources (rule_id, account_id, calendar_id) VALUES (?, ?, ?)",
      ).bind(row.rule_id, row.account_id, row.calendar_id),
    ),
  ]);

  return c.json<BlockRuleDTO>({
    id: ruleId,
    sources: sourceRows.map((row) => ({ accountId: row.account_id, calendarId: row.calendar_id })),
    target: { accountId: ruleRow.target_account_id, calendarId: ruleRow.target_calendar_id },
    mode: ruleRow.mode,
    oooFallback: body.id ? existingOooFallback : false,
  });
});

apiRoutes.delete("/api/block-rules", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  let body: BlockRuleDeleteRequest;
  try {
    body = await c.req.json<BlockRuleDeleteRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (!isValidBlockRuleDeleteRequest(body)) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  const existing = await c.env.DB.prepare("SELECT profile_id FROM block_rules WHERE id = ?")
    .bind(body.id)
    .first<{ profile_id: string }>();
  if (!isAccountInProfile(existing, profileId)) {
    return c.json<ApiError>({ error: "rule_not_found" }, 403);
  }

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM block_rules WHERE id = ?").bind(body.id),
    c.env.DB.prepare("DELETE FROM block_rule_sources WHERE rule_id = ?").bind(body.id),
    c.env.DB.prepare("DELETE FROM block_mirrors WHERE rule_id = ?").bind(body.id),
  ]);

  return c.body(null, 204);
});

apiRoutes.get("/api/calendars", requireAuth, async (c) => {
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

apiRoutes.post("/api/sync", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  let body: SyncRequest;
  try {
    body = await c.req.json<SyncRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (!body?.accountId || !body?.calendarId) {
    return c.json<ApiError>({ error: "missing_accountId_or_calendarId" }, 400);
  }

  const account = await c.env.DB.prepare("SELECT profile_id FROM accounts WHERE id = ?")
    .bind(body.accountId)
    .first<{ profile_id: string }>();
  if (!isAccountInProfile(account, profileId)) {
    return c.json<ApiError>({ error: "account_not_found" }, 403);
  }

  const stub = c.env.USER_SYNC.getByName(body.accountId);
  const result = await stub.sync(body.accountId, body.calendarId);
  return respondFromRpcResult(c, result);
});

// 予定の時刻変更を Google へ書き戻す (フェーズ5)。書き込み結果はレスポンスで返さない
// (ok のみ) — 正本は次の同期 (webhook/ポーリング → SSE 'changed' → クライアントの
// /api/sync) で還流する設計であり、ここで Google の応答をクライアントへ整形して
// 返すことはしない。失敗理由 (404/403/412/401 リトライ失敗など) は問わず一律 409 に
// マップする: クライアントはこれを「反映できなかった」信号としてローカルの
// 楽観更新をロールバックすればよく、理由ごとの分岐を必要としない。
apiRoutes.post("/api/event/patch", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  let body: EventPatchRequest;
  try {
    body = await c.req.json<EventPatchRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (
    !body?.accountId ||
    !body?.calendarId ||
    !body?.eventId ||
    typeof body.startMs !== "number" ||
    typeof body.endMs !== "number" ||
    !body?.timeZone
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
  const result = await stub.patchEvent(
    body.accountId,
    body.calendarId,
    body.eventId,
    body.startMs,
    body.endMs,
    body.timeZone,
  );
  if (!result.ok) {
    console.warn(
      `event patch failed: account=${body.accountId} calendar=${body.calendarId} event=${body.eventId} status=${result.status} error=${result.error}`,
    );
    return c.json<ApiError>({ error: "patch_failed" }, 409);
  }

  return c.json<EventPatchResponse>({ ok: true });
});

// 新規予定を Google へ作成する (フェーズ5)。エラーの一律 409 マッピング方針は /api/event/patch
// と同じ (コメント参照)。成功時は eventId のみ返す — UI が楽観的 occurrence の id を確定 id に
// 差し替えるためであり、それ以外の作成結果 (実際の start/end 等) を正本として返すことはしない。
// 正本は次の同期 (webhook/ポーリング → SSE 'changed' → クライアントの /api/sync) で還流する。
apiRoutes.post("/api/event/create", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  let body: EventCreateRequest;
  try {
    body = await c.req.json<EventCreateRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (
    !body?.accountId ||
    !body?.calendarId ||
    !body?.title ||
    typeof body.startMs !== "number" ||
    typeof body.endMs !== "number" ||
    !body?.timeZone
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
  const result = await stub.createEvent(
    body.accountId,
    body.calendarId,
    body.title,
    body.startMs,
    body.endMs,
    body.timeZone,
  );
  if (!result.ok) {
    console.warn(
      `event create failed: account=${body.accountId} calendar=${body.calendarId} status=${result.status} error=${result.error}`,
    );
    return c.json<ApiError>({ error: "create_failed" }, 409);
  }

  return c.json<EventCreateResponse>({ ok: true, eventId: result.data });
});

// 予定を Google から削除する (フェーズ5)。404 (既に削除済み) は UserSyncDO.deleteEvent /
// deleteEventWithRetry の中で成功扱いにしている (冪等) ので、ここに届く時点で ok:false は
// 本当の失敗 (403/412/5xx や 401 リトライ失敗) のみ。エラーの一律 409 マッピング方針は
// /api/event/patch と同じ (コメント参照)。
apiRoutes.post("/api/event/delete", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  let body: EventDeleteRequest;
  try {
    body = await c.req.json<EventDeleteRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (!body?.accountId || !body?.calendarId || !body?.eventId) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  const account = await c.env.DB.prepare("SELECT profile_id FROM accounts WHERE id = ?")
    .bind(body.accountId)
    .first<{ profile_id: string }>();
  if (!isAccountInProfile(account, profileId)) {
    return c.json<ApiError>({ error: "account_not_found" }, 403);
  }

  const stub = c.env.USER_SYNC.getByName(body.accountId);
  const result = await stub.deleteEvent(body.accountId, body.calendarId, body.eventId);
  if (!result.ok) {
    console.warn(
      `event delete failed: account=${body.accountId} calendar=${body.calendarId} event=${body.eventId} status=${result.status} error=${result.error}`,
    );
    return c.json<ApiError>({ error: "delete_failed" }, 409);
  }

  return c.json<EventDeleteResponse>({ ok: true });
});

// Google タスク連携 (docs/google-tasks.md、2026-07-20): アカウントのタスクリスト一覧。
// tasks はオプションスコープ (hasRequiredScopes には含めない) なので、未付与のユーザーは
// ここで初めて Google から 403 を受け取る。その 403 を tasks_scope_missing に変換して
// 返す (D1 にスコープを保存していないので、実際に叩いてみて判定する最小実装 —
// google/oauth.ts の hasTasksScope のコメント参照)。それ以外のエラーは通常どおり
// respondFromRpcResult で実 status のまま返す。
apiRoutes.get("/api/tasklists", requireAuth, async (c) => {
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
apiRoutes.post("/api/tasks/sync", requireAuth, async (c) => {
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
apiRoutes.post("/api/task/patch", requireAuth, async (c) => {
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

// リアルタイム反映用の SSE ストリーム。通知はトリガーに過ぎず、データそのものは運ばない
// (クライアントは 'changed' を受けたら該当 accountId/calendarId を /api/sync で取りに行く)。
// ProfileHubDO 自身は自分の名前 (profileId) を知らないので、転送時にヘッダで明示的に渡す。
apiRoutes.get("/api/events", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  const stub = c.env.PROFILE_HUB.getByName(profileId);
  const headers = new Headers(c.req.raw.headers);
  headers.set(PROFILE_ID_HEADER, profileId);
  const forwarded = new Request(c.req.raw, { headers });
  return stub.fetch(forwarded);
});

// 選択中カレンダーの push 通知 (watch channel) 登録/解除。best-effort: 登録に失敗しても
// (ローカル開発の localhost address 拒否など) 200 で `{ watching: false }` を返す
// (ポーリングフォールバックが補うので、クライアントにエラー扱いさせる必要が無い)。
apiRoutes.post("/api/watch", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  let body: WatchRequest;
  try {
    body = await c.req.json<WatchRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (!body?.accountId || !body?.calendarId || typeof body.enabled !== "boolean") {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  const account = await c.env.DB.prepare("SELECT profile_id FROM accounts WHERE id = ?")
    .bind(body.accountId)
    .first<{ profile_id: string }>();
  if (!isAccountInProfile(account, profileId)) {
    return c.json<ApiError>({ error: "account_not_found" }, 403);
  }

  if (!body.enabled) {
    await disableWatch(c.env, body.accountId, body.calendarId);
    return c.json<WatchApiResponse>({ watching: false });
  }

  const watching = await enableWatch(c.env, body.accountId, body.calendarId, profileId);
  return c.json<WatchApiResponse>({ watching });
});

// 連携解除 (アカウント削除)。accountId 指定ならそのアカウントだけ、省略ならプロファイル内
// 全アカウントを対象にする。対象ごとに: revoke → DO 状態クリア → D1 行削除、の順で実行
// (行削除を先にやると、その後 refresh_token を読めず revoke できなくなる事故が起きるため、
// 必ず revoke を最初に行う)。最後にプロファイルのアカウントが 0 件になった時だけ
// セッション (sid cookie) も破棄する。
apiRoutes.delete("/api/account", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;

  let body: DisconnectRequest = {};
  const rawBody = await c.req.text();
  if (rawBody) {
    try {
      body = JSON.parse(rawBody) as DisconnectRequest;
    } catch {
      return c.json<ApiError>({ error: "invalid_json" }, 400);
    }
  }

  const { results: profileAccountRows } = await c.env.DB.prepare(
    "SELECT id, is_owner FROM accounts WHERE profile_id = ?",
  )
    .bind(profileId)
    .all<{ id: string; is_owner: number }>();
  const profileAccounts: AccountMembership[] = profileAccountRows.map((row) => ({
    id: row.id,
    isOwner: row.is_owner === 1,
  }));

  const targets = resolveDisconnectTargets(body, profileAccounts);
  if (targets === null) {
    // body.accountId が指定されたが、このプロファイルには属していない (他人のアカウント等)。
    return c.json<ApiError>({ error: "account_not_found" }, 403);
  }

  for (const accountId of targets) {
    await disconnectAccount(c.env, accountId);
  }

  const remaining = profileAccounts.length - targets.length;
  if (shouldClearSessionAfterDisconnect(remaining)) {
    // プロファイルに Google アカウントが1つも残らない = プロファイル自体が実質消える
    // ので、ぶら下がっている GitHub 連携 (docs/github-oauth.md) も一緒に掃除する。
    await c.env.DB.prepare("DELETE FROM github_connections WHERE profile_id = ?")
      .bind(profileId)
      .run();
    deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
  }

  return c.body(null, 204);
});

/** 1 アカウント分の revoke → DO 状態クリア → D1 行削除。 */
async function disconnectAccount(env: Env, accountId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT refresh_token FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ refresh_token: string }>();

  if (row) {
    let refreshToken: string | null = null;
    try {
      refreshToken = await decryptToken(env.TOKEN_ENC_KEY, row.refresh_token);
    } catch (err) {
      if (!(err instanceof InvalidCiphertextError)) throw err;
      // 復号できない (旧平文行・改ざん等) トークンは revoke しようがない。「連携解除したい」
      // というユーザーの意図に対し、これは削除を妨げる理由にはならないのでスキップする。
      console.warn(
        `account deletion: refresh_token for account ${accountId} could not be decrypted, skipping revoke`,
      );
    }
    if (refreshToken) {
      const revoked = await revokeToken(fetch, refreshToken);
      if (!revoked) {
        console.warn(`account deletion: failed to revoke Google token for account ${accountId}`);
      }
    }
  }

  const stub = env.USER_SYNC.getByName(accountId);
  const clearResult = await stub.clearSyncState();
  if (!clearResult.ok) {
    console.warn(
      `account deletion: failed to clear DO sync state for account ${accountId}: ${clearResult.error}`,
    );
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM account_visible_calendars WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM account_calendar_prefs WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(accountId),
  ]);
}

/**
 * GET /api/me 用: 指定アカウント群のうち configured (account_calendar_prefs に行がある)
 * なものだけを対象に、選択中カレンダー id の配列を集約する。集約ロジック本体は
 * core/visible-calendars.ts の aggregateVisibleCalendars (純関数・テスト済み) に切り出してある。
 */
async function loadVisibleCalendars(
  env: Env,
  accountIds: string[],
): Promise<Record<string, string[]>> {
  if (accountIds.length === 0) return {};

  const placeholders = accountIds.map(() => "?").join(", ");
  const prefsResult = await env.DB.prepare(
    `SELECT account_id FROM account_calendar_prefs WHERE configured = 1 AND account_id IN (${placeholders})`,
  )
    .bind(...accountIds)
    .all<{ account_id: string }>();
  const visibleResult = await env.DB.prepare(
    `SELECT account_id, calendar_id FROM account_visible_calendars WHERE account_id IN (${placeholders})`,
  )
    .bind(...accountIds)
    .all<{ account_id: string; calendar_id: string }>();

  return aggregateVisibleCalendars(
    prefsResult.results.map((row) => row.account_id),
    visibleResult.results,
  );
}

/** GET /api/me 用: プロファイルの GitHub 連携 (docs/github-oauth.md)。無ければ null。 */
async function loadGitHubConnection(
  env: Env,
  profileId: string,
): Promise<{ login: string } | null> {
  const row = await env.DB.prepare(
    "SELECT github_login FROM github_connections WHERE profile_id = ?",
  )
    .bind(profileId)
    .first<{ github_login: string }>();
  return row ? { login: row.github_login } : null;
}

/**
 * POST /api/block-rules 用: 指定した accountId 群が全てこのプロファイルに属しているか。
 * 1件でも属していなければ false (他人のアカウント/カレンダーを参照させないための検証)。
 * 空配列は自明に true。
 */
async function accountsAllBelongToProfile(
  env: Env,
  accountIds: string[],
  profileId: string,
): Promise<boolean> {
  if (accountIds.length === 0) return true;
  const placeholders = accountIds.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT id FROM accounts WHERE profile_id = ? AND id IN (${placeholders})`,
  )
    .bind(profileId, ...accountIds)
    .all<{ id: string }>();
  return results.length === accountIds.length;
}

/**
 * GET /api/block-rules 用: プロファイルに属する block_rules + block_rule_sources を引き、
 * BlockRuleDTO[] に集約する。集約ロジック本体は core/block-rules.ts の aggregateBlockRules
 * (純関数・テスト済み) に切り出してある。
 */
async function loadBlockRules(env: Env, profileId: string): Promise<BlockRuleDTO[]> {
  const { results: ruleRows } = await env.DB.prepare(
    "SELECT id, profile_id, target_account_id, target_calendar_id, mode, created_at, ooo_fallback FROM block_rules WHERE profile_id = ? ORDER BY created_at ASC",
  )
    .bind(profileId)
    .all<BlockRuleRow>();
  if (ruleRows.length === 0) return [];

  const placeholders = ruleRows.map(() => "?").join(", ");
  const { results: sourceRows } = await env.DB.prepare(
    `SELECT rule_id, account_id, calendar_id FROM block_rule_sources WHERE rule_id IN (${placeholders})`,
  )
    .bind(...ruleRows.map((row) => row.id))
    .all<{ rule_id: string; account_id: string; calendar_id: string }>();

  return aggregateBlockRules(ruleRows, sourceRows);
}

/**
 * watch 登録の本体。既存 watch があれば Google を呼ばずに何もしない (true を返す)。
 * それ以外の失敗 (アクセストークン取得不可・Google API エラー・localhost 拒否など) は
 * すべて best-effort として飲み込み false を返す — 呼び出し元はこれを 200 として返す。
 */
async function enableWatch(
  env: Env,
  accountId: string,
  calendarId: string,
  profileId: string,
): Promise<boolean> {
  const existing = await env.DB.prepare(
    "SELECT 1 FROM watches WHERE account_id = ? AND calendar_id = ?",
  )
    .bind(accountId, calendarId)
    .first();
  if (existing) {
    return true;
  }

  try {
    const stub = env.USER_SYNC.getByName(accountId);
    const tokenResult = await stub.getValidAccessToken(accountId);
    if (!tokenResult.ok) {
      console.warn(
        `watch registration: could not get access token for account ${accountId}: ${tokenResult.error}`,
      );
      return false;
    }

    const channelId = crypto.randomUUID();
    const channelToken = await computeChannelToken(env.SESSION_SECRET, channelId);
    const registered = await registerWatch(fetch, tokenResult.data, {
      calendarId,
      channelId,
      address: buildWebhookAddress(env.WEBHOOK_BASE_URL),
      token: channelToken,
    });

    const row = buildWatchRow(
      { accountId, calendarId },
      profileId,
      channelId,
      registered,
      Date.now(),
    );
    await env.DB.prepare(
      `INSERT INTO watches (channel_id, resource_id, account_id, calendar_id, profile_id, expiration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.channel_id,
        row.resource_id,
        row.account_id,
        row.calendar_id,
        row.profile_id,
        row.expiration_ms,
        row.created_at,
      )
      .run();

    return true;
  } catch (err) {
    console.warn(
      `watch registration failed (best-effort) for account=${accountId} calendar=${calendarId}`,
      err,
    );
    return false;
  }
}

/** watch 解除。既に watch が無ければ何もしない。Google 側の停止に失敗してもローカルの行は削除する
 * (「監視を止めたい」というクライアントの意図を妨げる理由にはならない — revokeToken と同じ考え方)。 */
async function disableWatch(env: Env, accountId: string, calendarId: string): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT channel_id, resource_id FROM watches WHERE account_id = ? AND calendar_id = ?",
  )
    .bind(accountId, calendarId)
    .first<{ channel_id: string; resource_id: string | null }>();
  if (!row) return;

  if (row.resource_id) {
    try {
      const stub = env.USER_SYNC.getByName(accountId);
      const tokenResult = await stub.getValidAccessToken(accountId);
      if (tokenResult.ok) {
        await stopWatch(fetch, tokenResult.data, {
          channelId: row.channel_id,
          resourceId: row.resource_id,
        });
      }
    } catch (err) {
      console.warn(
        `watch stop failed (continuing to delete local row) for account=${accountId} calendar=${calendarId}`,
        err,
      );
    }
  }

  await env.DB.prepare("DELETE FROM watches WHERE channel_id = ?").bind(row.channel_id).run();
}

function respondFromRpcResult<T>(c: Context<AppEnv>, result: RpcResult<T>) {
  if (result.ok) {
    return c.json(result.data);
  }
  // RpcResult.status は Google/内部エラーに由来する実 HTTP ステータス (401/403/404/410/429/5xx など)。
  // 1xx や 204/304 のような「本文なし」コードにはならない。
  return c.json<ApiError>({ error: result.error }, result.status as ContentfulStatusCode);
}
