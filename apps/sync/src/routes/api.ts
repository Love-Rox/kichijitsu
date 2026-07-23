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
  EventRsvpRequest,
  EventRsvpResponse,
  GitHubActivityResponse,
  GitHubCiRunsResponse,
  GitHubItemsResponse,
  GitHubQueueResponse,
  McpTokenCreateRequest,
  McpTokenCreateResponse,
  McpTokenDeleteRequest,
  McpTokenDTO,
  McpTokensResponse,
  MeResponse,
  PullCommitsRequest,
  PullCommitsResponse,
  SyncRequest,
  TaskListsResponse,
  TaskPatchRequest,
  TaskPatchResponse,
  TasksSyncRequest,
  TasksSyncResponse,
  VisibleCalendarsRequest,
  WatchRequest,
  WorkLogCreateRequest,
  WorkLogCreateResponse,
  WorkLogDTO,
  WorkLogsResponse,
  WorkLogUpdateRequest,
} from "@kichijitsu/shared";
import type { AppEnv } from "../types";
import { populateProfileId, requireAuth } from "../middleware";
import { SESSION_COOKIE_NAME } from "../session";
import { decryptToken, InvalidCiphertextError } from "../crypto";
import { revokeToken } from "../google/oauth";
import { fetchGitHubActivity } from "../core/github-activity";
import { fetchGitHubCiRuns } from "../core/github-ci";
import { fetchGitHubItems } from "../core/github-items";
import { fetchGitHubQueue } from "../core/github-queue";
import { fetchPullCommitsForItems } from "../core/github-pr-commits";
import { GitHubApiError } from "../github/http";
import { registerWatch, stopWatch, buildWebhookAddress } from "../google/watch";
import {
  isAccountInProfile,
  resolveDisconnectTargets,
  shouldClearSessionAfterDisconnect,
  type AccountMembership,
} from "../accounts";
import { buildWatchRow, shouldAttemptWatchRepair, shouldEnsureWatch } from "../core/watch-service";
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
import { generateMcpToken, hashMcpToken } from "../mcp-token";
import {
  buildWorkLogRow,
  deleteWorkLog,
  insertWorkLog,
  listWorkLogsForProfile,
  resolveManualWorkLogAgent,
  updateWorkLog,
  validateWorkLogInput,
} from "../core/work-log";
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

  const resolved = await resolveGitHubAccessToken(c.env, profileId, "github items");
  if (!resolved.ok) {
    return c.json<ApiError>({ error: resolved.error }, resolved.status);
  }

  try {
    const items = await fetchGitHubItems({ fetch, token: resolved.token });
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

// GitHub 作業キュー取得 (docs/github-integration.md フェーズ②「作業キュー」、2026-07-20)。
// review request / assigned issue / 自分の open PR を Search API 横断で取って DTO で返す
// だけ (サーバーは永続化しない)。表示 (サイドレール) は Part B で別途。
// エラーマッピングは /api/github/items と同じ (resolveGitHubAccessToken を共有)。
apiRoutes.get("/api/github/queue", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;

  const resolved = await resolveGitHubAccessToken(c.env, profileId, "github queue");
  if (!resolved.ok) {
    return c.json<ApiError>({ error: resolved.error }, resolved.status);
  }

  try {
    const items = await fetchGitHubQueue({ fetch, token: resolved.token });
    return c.json<GitHubQueueResponse>({ items });
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 401) {
      console.warn(`github queue: GitHub rejected the access token for profile ${profileId}`);
      return c.json<ApiError>({ error: "github_auth_expired" }, 401);
    }
    console.error(`github queue: fetch failed for profile ${profileId}`, err);
    return c.json<ApiError>({ error: "github_fetch_failed" }, 502);
  }
});

// GitHub 実績オーバーレイ取得 (docs/github-integration.md フェーズ③「実績オーバーレイ」
// Part A、2026-07-20)。インストール先 repo に対して自分の commit 活動 (author=login) を
// since/until (クライアントが渡す表示中の時間帯) で取って DTO で返すだけ (サーバーは
// 永続化しない)。表示 (グリッドへの薄いオーバーレイ) は Part B で別途。
// - since/until が無ければ 400 missing_range (per-repo commit 取得を範囲限定するための
//   必須パラメータ)。
// - 範囲が MAX_ACTIVITY_RANGE_DAYS を超えたら 400 range_too_wide (per-repo 反復が膨らむのを防ぐ)。
// - エラーマッピングは /api/github/items・/api/github/queue と同じ (resolveGitHubAccessToken
//   を共有)。
// since/until の検証自体は /api/github/ci (フェーズ④b) と共通なので parseRequiredRange に
// 切り出してある (挙動・エラーコードは変えていない)。
const MAX_ACTIVITY_RANGE_DAYS = 62;

apiRoutes.get("/api/github/activity", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;

  const range = parseRequiredRange(c, MAX_ACTIVITY_RANGE_DAYS);
  if (!range.ok) {
    return c.json<ApiError>({ error: range.error }, 400);
  }

  const resolved = await resolveGitHubAccessToken(c.env, profileId, "github activity");
  if (!resolved.ok) {
    return c.json<ApiError>({ error: resolved.error }, resolved.status);
  }

  try {
    const items = await fetchGitHubActivity({
      fetch,
      token: resolved.token,
      login: resolved.login,
      sinceIso: range.sinceIso,
      untilIso: range.untilIso,
    });
    return c.json<GitHubActivityResponse>({ items });
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 401) {
      console.warn(`github activity: GitHub rejected the access token for profile ${profileId}`);
      return c.json<ApiError>({ error: "github_auth_expired" }, 401);
    }
    console.error(`github activity: fetch failed for profile ${profileId}`, err);
    return c.json<ApiError>({ error: "github_fetch_failed" }, 502);
  }
});

// GitHub CI/Actions 実行取得 (docs/github-integration.md フェーズ④b「CI/Actions 実行を
// タイムラインに薄く重ねる」、2026-07-20)。インストール先 repo に対して workflow run を
// since/until (クライアントが渡す表示中の時間帯) で取って DTO で返すだけ (サーバーは
// 永続化しない)。/api/github/activity (フェーズ③) と同じ流儀だが、③ と違い自分がトリガーした
// 分に限定しない (誰の push の CI 実行でも見える、core/github-ci.ts 参照)。
// - since/until の検証は /api/github/activity と共通 (parseRequiredRange)。
// - エラーマッピングも /api/github/activity と同じ (resolveGitHubAccessToken を共有)。
const MAX_CI_RANGE_DAYS = 62;

apiRoutes.get("/api/github/ci", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;

  const range = parseRequiredRange(c, MAX_CI_RANGE_DAYS);
  if (!range.ok) {
    return c.json<ApiError>({ error: range.error }, 400);
  }

  const resolved = await resolveGitHubAccessToken(c.env, profileId, "github ci");
  if (!resolved.ok) {
    return c.json<ApiError>({ error: resolved.error }, resolved.status);
  }

  try {
    const items = await fetchGitHubCiRuns(
      { fetch, token: resolved.token },
      range.sinceIso,
      range.untilIso,
    );
    return c.json<GitHubCiRunsResponse>({ items });
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 401) {
      console.warn(`github ci: GitHub rejected the access token for profile ${profileId}`);
      return c.json<ApiError>({ error: "github_auth_expired" }, 401);
    }
    console.error(`github ci: fetch failed for profile ${profileId}`, err);
    return c.json<ApiError>({ error: "github_fetch_failed" }, 502);
  }
});

// PR ごとの自分の commit 時刻取得 (docs/github-integration.md フェーズ③「時間計測」Part A、
// 2026-07-20)。予定ブロックに紐づく PR のリストを受け取り、各 PR について自分 (login) の
// commit の ISO タイムスタンプ配列を返すだけ (サーバーは永続化しない)。クラスタリングして
// 実績時間として見せる UI は Part B で別途 (このエンドポイントは生の時刻列を返すのみ)。
// - items が配列でない/各要素の repo・number の型が不正なら 400 missing_fields。
// - items が空配列なら GitHub を叩かず即 200 { commitsByItem: {} }。
// - エラーマッピングは /api/github/items・/api/github/queue・/api/github/activity と同じ
//   (resolveGitHubAccessToken を共有)。ただし 1 PR 単位の失敗は
//   core/github-pr-commits.ts の fetchPullCommitsForItems が内部で握って継続するので、
//   ここまで届くのはトークン失効など全体に関わる失敗のみ。
apiRoutes.post("/api/github/pr-commits", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  let body: PullCommitsRequest;
  try {
    body = await c.req.json<PullCommitsRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (
    !Array.isArray(body?.items) ||
    body.items.some(
      (item) =>
        typeof item?.repo !== "string" ||
        item.repo.length === 0 ||
        typeof item?.number !== "number",
    )
  ) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  if (body.items.length === 0) {
    return c.json<PullCommitsResponse>({ commitsByItem: {} });
  }

  const resolved = await resolveGitHubAccessToken(c.env, profileId, "github pr-commits");
  if (!resolved.ok) {
    return c.json<ApiError>({ error: resolved.error }, resolved.status);
  }

  try {
    const commitsByItem = await fetchPullCommitsForItems(
      { fetch, token: resolved.token, login: resolved.login },
      body.items,
    );
    return c.json<PullCommitsResponse>({ commitsByItem });
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 401) {
      console.warn(`github pr-commits: GitHub rejected the access token for profile ${profileId}`);
      return c.json<ApiError>({ error: "github_auth_expired" }, 401);
    }
    console.error(`github pr-commits: fetch failed for profile ${profileId}`, err);
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

// MCP トークン管理 (docs/mcp.md Part A、2026-07-20)。`/mcp` エンドポイント自体 (Part B) は
// このフェーズのスコープ外 — ここではトークンのライフサイクル (発行/一覧/失効) だけを扱う。
// 生トークンは POST のレスポンスでのみ一度だけ返り、DB には SHA-256 ハッシュしか保存しない
// (mcp-token.ts 参照)。/mcp 側の認証は Part B が mcp-auth.ts の resolveProfileFromMcpToken を
// 使って実装する想定。
apiRoutes.get("/api/mcp-tokens", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  const { results } = await c.env.DB.prepare(
    "SELECT id, label, created_at, last_used_at FROM mcp_tokens WHERE profile_id = ? ORDER BY created_at ASC",
  )
    .bind(profileId)
    .all<{ id: string; label: string | null; created_at: number; last_used_at: number | null }>();
  const tokens: McpTokenDTO[] = results.map((row) => ({
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
  return c.json<McpTokensResponse>({ tokens });
});

apiRoutes.post("/api/mcp-tokens", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  let body: McpTokenCreateRequest;
  try {
    body = await c.req.json<McpTokenCreateRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }

  // 空文字ラベルは「未指定」と同じ扱いにする (DB 上は NULL に正規化、一覧表示側の
  // 「(無題)」プレースホルダ判定を label === null だけで済ませるため)。
  const label = body.label?.trim() ? body.label.trim() : null;

  const { raw } = generateMcpToken();
  const tokenHash = await hashMcpToken(raw);
  const id = crypto.randomUUID();
  const createdAt = Date.now();

  await c.env.DB.prepare(
    "INSERT INTO mcp_tokens (id, profile_id, token_hash, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, profileId, tokenHash, label, createdAt, null)
    .run();

  // raw はここでのみ返す — レスポンスボディ以外(ログ含む)には一切出さない。
  return c.json<McpTokenCreateResponse>({ token: raw, id, label, createdAt });
});

apiRoutes.delete("/api/mcp-tokens", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  let body: McpTokenDeleteRequest;
  try {
    body = await c.req.json<McpTokenDeleteRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (!body.id) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  const existing = await c.env.DB.prepare("SELECT profile_id FROM mcp_tokens WHERE id = ?")
    .bind(body.id)
    .first<{ profile_id: string }>();
  if (!isAccountInProfile(existing, profileId)) {
    // 存在しない id と「他人のプロファイルの id」を区別せず 403 にする (block-rules と同じ方針)。
    return c.json<ApiError>({ error: "token_not_found" }, 403);
  }

  await c.env.DB.prepare("DELETE FROM mcp_tokens WHERE id = ?").bind(body.id).run();
  return c.body(null, 204);
});

// 作業実績記録 (docs/mcp.md「エージェントの作業時間記録」、2026-07-21 D1 保存へ移行) の閲覧経路。
// 書き込み (POST /api/work-intervals, routes/work-intervals.ts) は MCP トークンの Bearer 認証だが、
// こちらは web 用でセッション cookie 認証 (requireAuth) — 認証経路が異なる点に注意。
// since/until (epoch ms の文字列、任意) で start_ms/end_ms を絞り込める。件数上限は新しい順 500件。
// SELECT 本体は core/work-log.ts の listWorkLogsForProfile に切り出してある (MCP ツール
// work_summary と共有するため、2026-07-21) — 挙動 (絞り込み条件・並び・上限) は変えていない。
apiRoutes.get("/api/work-logs", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;

  const since = c.req.query("since");
  const sinceMs = since && !Number.isNaN(Number(since)) ? Number(since) : undefined;
  const until = c.req.query("until");
  const untilMs = until && !Number.isNaN(Number(until)) ? Number(until) : undefined;

  const results = await listWorkLogsForProfile(c.env, profileId, sinceMs, untilMs);

  const workLogs: WorkLogDTO[] = results.map((row) => ({
    id: row.id,
    repo: row.repo,
    ...(row.issue_ref ? { issueRef: row.issue_ref } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.agent ? { agent: row.agent } : {}),
    startMs: row.start_ms,
    endMs: row.end_ms,
  }));

  return c.json<WorkLogsResponse>({ workLogs });
});

// 実績の手動追加 (TimeReportOverlay「実績を手動で追加」フォーム、2026-07-22)。
// POST /api/work-intervals (routes/work-intervals.ts, Bearer 認証, hook 用) とは認証経路が別 —
// こちらはセッション cookie (requireAuth) で、body の形は WorkIntervalRequest と同じ ISO 文字列の
// start/end (web 側が datetime-local → ISO に変換して送る、sync/workLogEntry.ts 参照)。
// owner アカウント解決は行わない — work-intervals.ts と同じ理由 (Google アカウントに紐付かない
// アプリ固有データなので、profileId だけで書ける)。agent 未指定時は resolveManualWorkLogAgent が
// "manual" を補い、これを見て web 側が hook 記録と手動記録を区別する。
apiRoutes.post("/api/work-logs", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;

  let body: WorkLogCreateRequest;
  try {
    body = await c.req.json<WorkLogCreateRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (
    typeof body?.start !== "string" ||
    typeof body?.end !== "string" ||
    typeof body?.repo !== "string"
  ) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }
  // 任意フィールド (agent/branch/issueRef) は「省略」か「文字列」のみ許す。非文字列を
  // 渡されると下流 (resolveManualWorkLogAgent の .trim() 等) で TypeError → 500 になるため、
  // start/end/repo と同じ流儀でここで 400 に落とす。
  if (
    (body.agent !== undefined && typeof body.agent !== "string") ||
    (body.branch !== undefined && typeof body.branch !== "string") ||
    (body.issueRef !== undefined && typeof body.issueRef !== "string")
  ) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  const validationError = validateWorkLogInput({
    startIso: body.start,
    endIso: body.end,
    repo: body.repo,
  });
  if (validationError) {
    return c.json<ApiError>({ error: validationError }, 400);
  }

  const row = buildWorkLogRow(
    crypto.randomUUID(),
    profileId,
    {
      startIso: body.start,
      endIso: body.end,
      repo: body.repo,
      branch: body.branch,
      issueRef: body.issueRef,
      agent: resolveManualWorkLogAgent(body.agent),
    },
    Date.now(),
  );
  await insertWorkLog(c.env, row);

  return c.json<WorkLogCreateResponse>({ id: row.id }, 200);
});

// 実績の手動削除 (手入力の訂正用、2026-07-22)。対象は id が指すプロファイル自身の work_log 行のみ
// — 他プロファイルの id は「無い id」と区別せず 403 にする (block-rules/mcp-tokens と同じ方針)。
// 所有チェック・DELETE 本体は core/work-log.ts の deleteWorkLog に切り出してある。
apiRoutes.delete("/api/work-logs/:id", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  const id = c.req.param("id");

  const result = await deleteWorkLog(c.env, profileId, id);
  if (result === "not_found") {
    return c.json<ApiError>({ error: "work_log_not_found" }, 403);
  }
  return c.body(null, 204);
});

// 実績の手動編集 (手入力の後追い訂正用、2026-07-23)。全フィールド任意の部分更新 —
// body に含めたキーだけを更新する。認証・所有チェックの方針は DELETE /api/work-logs/:id と同じ
// (セッション cookie / 他プロファイル・存在しない id は区別せず 403 work_log_not_found)。
// 型検証・部分検証は POST /api/work-logs と同じ流儀 (存在するフィールドは各々 string、
// 非文字列は 400 missing_fields)。start/end/repo が来た分だけ validateWorkLogInput 相当で検証する。
//
// start<end の検証方針: start と end の「両方」が同時に来たときだけ行う。片方だけの部分更新では
// 相手側の値が body に無く、更新後の整合を判定するには既存行の start_ms/end_ms を追加で SELECT
// するか、updateWorkLog の戻り値 ("updated"|"not_found") に検証失敗を混ぜる必要があり、DELETE と
// 揃えた薄い所有チェックの流儀に対して複雑さが見合わない。片方更新で区間が反転しても、集計側
// (core/work-log.ts の aggregateWorkLogs) が start_ms >= end_ms の行を除外する防御を既に持つため、
// ここでは「両方来たときだけ」に留める (docs 無し・実装判断)。
apiRoutes.patch("/api/work-logs/:id", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  const id = c.req.param("id");

  let body: WorkLogUpdateRequest;
  try {
    body = await c.req.json<WorkLogUpdateRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  // 全フィールド任意だが、存在するなら string のみ許す (非文字列は下流の Date.parse/D1 bind で
  // 事故になるため、POST と同じく 400 missing_fields に落とす)。
  if (
    (body?.start !== undefined && typeof body.start !== "string") ||
    (body?.end !== undefined && typeof body.end !== "string") ||
    (body?.repo !== undefined && typeof body.repo !== "string") ||
    (body?.issueRef !== undefined && typeof body.issueRef !== "string") ||
    (body?.branch !== undefined && typeof body.branch !== "string") ||
    (body?.agent !== undefined && typeof body.agent !== "string")
  ) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  // 与えられた分だけ validateWorkLogInput 相当の検証を行う (部分更新)。
  if (body.repo !== undefined && body.repo.trim().length === 0) {
    return c.json<ApiError>({ error: "missing_repo" }, 400);
  }
  if (body.start !== undefined && Number.isNaN(Date.parse(body.start))) {
    return c.json<ApiError>({ error: "invalid_start" }, 400);
  }
  if (body.end !== undefined && Number.isNaN(Date.parse(body.end))) {
    return c.json<ApiError>({ error: "invalid_end" }, 400);
  }
  // start<end は両方揃ったときだけ (上のコメント参照)。
  if (
    body.start !== undefined &&
    body.end !== undefined &&
    Date.parse(body.start) >= Date.parse(body.end)
  ) {
    return c.json<ApiError>({ error: "start_not_before_end" }, 400);
  }

  const result = await updateWorkLog(c.env, profileId, id, {
    startIso: body.start,
    endIso: body.end,
    repo: body.repo,
    issueRef: body.issueRef,
    branch: body.branch,
    agent: body.agent,
  });
  if (result === "not_found") {
    return c.json<ApiError>({ error: "work_log_not_found" }, 403);
  }
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
  const result = await stub.sync(body.accountId, body.calendarId, body.deviceId, body.forceFull);
  if (result.ok) {
    // watch 自己修復 (best-effort)。正経路は選択トグル時の POST /api/watch のみなので、
    // watches 行の消失/取り違え (プロファイル作り直し事故など) を放置すると手動でトグルし
    // 直すまで直らない — ここで同期成功のたびに検知して直す。レスポンスはブロックしない。
    c.executionCtx.waitUntil(
      repairWatchIfNeeded(c.env, body.accountId, body.calendarId, profileId, Date.now()),
    );
  }
  return respondFromRpcResult(c, result);
});

// 予定の変更を Google へ書き戻す (フェーズ5、2026-07-22 全項目編集に拡張)。書き込み結果は
// レスポンスで返さない (ok のみ) — 正本は次の同期 (webhook/ポーリング → SSE 'changed' →
// クライアントの /api/sync) で還流する設計であり、ここで Google の応答をクライアントへ
// 整形して返すことはしない。失敗理由 (404/403/412/401 リトライ失敗など) は問わず一律 409 に
// マップする: クライアントはこれを「反映できなかった」信号としてローカルの
// 楽観更新をロールバックすればよく、理由ごとの分岐を必要としない。
// summary/location/description/isAllDay は optional — 未指定の旧クライアント (時刻のみ
// 送るリクエスト) もそのまま動く (後方互換)。指定された場合のみ型チェックする
// (undefined を許容しつつ、指定した値の型は誤りを弾く)。
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
    !body?.timeZone ||
    (body.summary !== undefined && typeof body.summary !== "string") ||
    (body.location !== undefined && typeof body.location !== "string") ||
    (body.description !== undefined && typeof body.description !== "string") ||
    (body.isAllDay !== undefined && typeof body.isAllDay !== "boolean")
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
    {
      summary: body.summary,
      location: body.location,
      description: body.description,
      isAllDay: body.isAllDay,
    },
  );
  if (!result.ok) {
    console.warn(
      `event patch failed: account=${body.accountId} calendar=${body.calendarId} event=${body.eventId} status=${result.status} error=${result.error}`,
    );
    return c.json<ApiError>({ error: "patch_failed" }, 409);
  }

  return c.json<EventPatchResponse>({ ok: true });
});

// 自分の参加ステータス (RSVP) を Google へ書き戻す (2026-07-22)。認可チェック
// (requireAuth + isAccountInProfile) は /api/event/patch と同じ。responseStatus は
// Google の4値のみ許可する。self attendee が見つからない予定は RpcResult.error ===
// "not_an_attendee" (core/rsvp-event.ts → NotAnAttendeeError → rpc-result.ts) として
// 422 で明確に区別して返す — それ以外の失敗は /api/event/patch と同じ一律 409
// (理由ごとの分岐をクライアントに要求しない方針)。
apiRoutes.post("/api/event/rsvp", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  let body: EventRsvpRequest;
  try {
    body = await c.req.json<EventRsvpRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (
    !body?.accountId ||
    !body?.calendarId ||
    !body?.eventId ||
    (body.responseStatus !== "accepted" &&
      body.responseStatus !== "declined" &&
      body.responseStatus !== "tentative" &&
      body.responseStatus !== "needsAction")
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
  const result = await stub.rsvpEvent(
    body.accountId,
    body.calendarId,
    body.eventId,
    body.responseStatus,
  );
  if (!result.ok) {
    console.warn(
      `event rsvp failed: account=${body.accountId} calendar=${body.calendarId} event=${body.eventId} status=${result.status} error=${result.error}`,
    );
    if (result.error === "not_an_attendee") {
      return c.json<ApiError>({ error: "not_an_attendee" }, 422);
    }
    return c.json<ApiError>({ error: "rsvp_failed" }, 409);
  }

  return c.json<EventRsvpResponse>({ ok: true });
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
    // ので、ぶら下がっている GitHub 連携 (docs/github-oauth.md)・MCP トークン
    // (docs/mcp.md、2026-07-20)・作業実績 (docs/mcp.md「エージェントの作業時間記録」、
    // 2026-07-21 D1 保存へ移行) も一緒に掃除する。
    await c.env.DB.prepare("DELETE FROM github_connections WHERE profile_id = ?")
      .bind(profileId)
      .run();
    await c.env.DB.prepare("DELETE FROM mcp_tokens WHERE profile_id = ?").bind(profileId).run();
    await c.env.DB.prepare("DELETE FROM work_logs WHERE profile_id = ?").bind(profileId).run();
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

/**
 * GET /api/github/activity・/api/github/ci 共通: クエリの since/until を検証する
 * (docs/github-integration.md フェーズ③④b、2026-07-20 DRY 化)。since/until が無い、または
 * Date.parse できなければ missing_range、範囲が maxRangeDays を超えれば range_too_wide を
 * 返す (エラーコード・判定基準は元々2ルートで重複していたコードと同一、挙動は変えていない)。
 */
type RangeValidation =
  | { ok: true; sinceIso: string; untilIso: string }
  | { ok: false; error: "missing_range" | "range_too_wide" };

function parseRequiredRange(c: Context<AppEnv>, maxRangeDays: number): RangeValidation {
  const sinceIso = c.req.query("since");
  const untilIso = c.req.query("until");
  if (!sinceIso || !untilIso) {
    return { ok: false, error: "missing_range" };
  }
  const sinceMs = Date.parse(sinceIso);
  const untilMs = Date.parse(untilIso);
  if (Number.isNaN(sinceMs) || Number.isNaN(untilMs)) {
    return { ok: false, error: "missing_range" };
  }
  const rangeDays = (untilMs - sinceMs) / (24 * 60 * 60 * 1000);
  if (rangeDays > maxRangeDays) {
    return { ok: false, error: "range_too_wide" };
  }
  return { ok: true, sinceIso, untilIso };
}

/**
 * GET /api/github/items・/api/github/queue・/api/github/activity で共通のトークン解決
 * (docs/github-integration.md フェーズ①②③、2026-07-20)。github_connections を profileId で
 * 引いて復号するだけの処理が各ルートで重複していたので DRY 化した — 挙動 (未連携 409 /
 * 復号失敗 401) は変えていない。
 * `login` も併せて返す (フェーズ③の commits API が author=login を要求するため、
 * github_login を SELECT に追加して拡張した — 既存の呼び出し側 (①②) は login を無視する
 * だけなので非破壊)。
 */
type GitHubTokenResolution =
  | { ok: true; token: string; login: string }
  | { ok: false; error: "github_not_connected" | "github_auth_expired"; status: 409 | 401 };

async function resolveGitHubAccessToken(
  env: Env,
  profileId: string,
  logPrefix: string,
): Promise<GitHubTokenResolution> {
  const connection = await env.DB.prepare(
    "SELECT access_token, github_login FROM github_connections WHERE profile_id = ?",
  )
    .bind(profileId)
    .first<{ access_token: string; github_login: string }>();
  if (!connection) {
    return { ok: false, error: "github_not_connected", status: 409 };
  }

  try {
    const token = await decryptToken(env.TOKEN_ENC_KEY, connection.access_token);
    return { ok: true, token, login: connection.github_login };
  } catch (err) {
    if (!(err instanceof InvalidCiphertextError)) throw err;
    console.warn(`${logPrefix}: could not decrypt access_token for profile ${profileId}`);
    return { ok: false, error: "github_auth_expired", status: 401 };
  }
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
 * watch 登録の本体。既存行が現プロファイルに紐づき、かつ未失効ならその行を信頼して Google を
 * 呼ばずに何もしない (true を返す)。既存行が古いプロファイルに紐づく、または失効している場合は
 * Cron の再登録 (renewWatch, ../index.ts) と同じ順序 — 古い channel を stop → 新しい channel を
 * 登録 → (account_id, calendar_id) の unique index に触れるため削除+挿入を1つの batch に
 * まとめる — で張り替える (POST /api/sync 成功後の自己修復 (下記 repairWatchIfNeeded) は
 * この張り替えに乗っかる)。
 * それ以外の失敗 (アクセストークン取得不可・Google API エラー・localhost 拒否など) は
 * すべて best-effort として飲み込み false を返す — 呼び出し元はこれを 200 として返す
 * (POST /api/watch) か、ログするだけ (repairWatchIfNeeded) にする。
 */
async function enableWatch(
  env: Env,
  accountId: string,
  calendarId: string,
  profileId: string,
): Promise<boolean> {
  const existing = await env.DB.prepare(
    "SELECT channel_id, resource_id, profile_id, expiration_ms FROM watches WHERE account_id = ? AND calendar_id = ?",
  )
    .bind(accountId, calendarId)
    .first<{
      channel_id: string;
      resource_id: string | null;
      profile_id: string;
      expiration_ms: number | null;
    }>();

  const now = Date.now();
  // expiration_ms が null (Google が expiration を返さなかった watch) は「いつ切れるか
  // 分からない」行なので、既に切れている (0 < now) 扱いにして張り替え側に倒す — Cron の
  // selectWatchesNeedingRenewal とは逆の安全側 (張り替えは stop→re-register の二重登録耐性が
  // あるだけの best-effort 操作であり、Cron の「触らず待つ」判断とは前提が違う)。
  if (
    existing &&
    !shouldEnsureWatch(
      { profile_id: existing.profile_id, expiration_ms: existing.expiration_ms ?? 0 },
      profileId,
      now,
    )
  ) {
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

    if (existing?.resource_id) {
      const stopped = await stopWatch(fetch, tokenResult.data, {
        channelId: existing.channel_id,
        resourceId: existing.resource_id,
      });
      if (!stopped) {
        console.warn(
          `watch registration: failed to stop stale channel ${existing.channel_id} for account=${accountId} calendar=${calendarId} (continuing to re-register anyway)`,
        );
      }
    }

    const channelId = crypto.randomUUID();
    const channelToken = await computeChannelToken(env.SESSION_SECRET, channelId);
    const registered = await registerWatch(fetch, tokenResult.data, {
      calendarId,
      channelId,
      address: buildWebhookAddress(env.WEBHOOK_BASE_URL),
      token: channelToken,
    });

    const row = buildWatchRow({ accountId, calendarId }, profileId, channelId, registered, now);
    const insert = env.DB.prepare(
      `INSERT INTO watches (channel_id, resource_id, account_id, calendar_id, profile_id, expiration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.channel_id,
      row.resource_id,
      row.account_id,
      row.calendar_id,
      row.profile_id,
      row.expiration_ms,
      row.created_at,
    );

    if (existing) {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM watches WHERE account_id = ? AND calendar_id = ?").bind(
          accountId,
          calendarId,
        ),
        insert,
      ]);
    } else {
      await insert.run();
    }

    return true;
  } catch (err) {
    console.warn(
      `watch registration failed (best-effort) for account=${accountId} calendar=${calendarId}`,
      err,
    );
    return false;
  }
}

/** キー = `${accountId}:${calendarId}`、値 = 最終「登録試行」時刻 (ms)。isolate 単位で揮発する
 * best-effort のスロットルであり、D1 に永続化するほどの重要性は無い (押しても実害は
 * 「次の isolate でもう1回試す」程度)。 */
const lastWatchRepairAttempt = new Map<string, number>();

/**
 * POST /api/sync 成功後の watch 自己修復 (best-effort)。
 *
 * watch 登録の正経路はクライアントがカレンダー選択をトグルした時の POST /api/watch
 * (enabled:true) であり、これはそれを補うだけの自己修復 — プロファイル作り直し事故などで
 * watches 行が失われた/古いプロファイルに紐づいたまま残ったケースを、次の同期成功時に検知
 * して直す。呼び出し元 (POST /api/sync) は waitUntil に渡すので、レスポンスはブロックしない。
 */
async function repairWatchIfNeeded(
  env: Env,
  accountId: string,
  calendarId: string,
  profileId: string,
  now: number,
): Promise<void> {
  const existing = await env.DB.prepare(
    "SELECT profile_id, expiration_ms FROM watches WHERE account_id = ? AND calendar_id = ?",
  )
    .bind(accountId, calendarId)
    .first<{ profile_id: string; expiration_ms: number | null }>();

  const row = existing
    ? { profile_id: existing.profile_id, expiration_ms: existing.expiration_ms ?? 0 }
    : null;
  if (!shouldEnsureWatch(row, profileId, now)) {
    return;
  }

  // push 非対応カレンダー (祝日カレンダーなど) は登録の度に失敗するので、同期の度に Google を
  // 叩き続けないようスロットルする。
  const key = `${accountId}:${calendarId}`;
  if (!shouldAttemptWatchRepair(lastWatchRepairAttempt.get(key), now)) {
    return;
  }
  lastWatchRepairAttempt.set(key, now);

  try {
    await enableWatch(env, accountId, calendarId, profileId);
  } catch (err) {
    // enableWatch は内部で失敗を飲み込み false を返す設計だが、念のため二重に守る
    // (ここでの失敗は best-effort であり /api/sync のレスポンスに影響させない)。
    console.warn(
      `watch self-repair failed (best-effort) for account=${accountId} calendar=${calendarId}`,
      err,
    );
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
