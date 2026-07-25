/**
 * プロファイル設定まわりの残りのルート: `/api/me`、カレンダー選択 (`/api/visible-calendars`)、
 * カレンダーブロック (`/api/block-rules`、docs/blocking.md)、MCP トークン (`/api/mcp-tokens`、
 * docs/mcp.md)、push 通知の登録/解除 (`/api/watch`)、連携解除 (`/api/account`)。
 * routes/api.ts から分割 (2026-07-25) — 挙動は変えていない。
 *
 * `GET /api/me` はこのアプリで唯一 requireAuth が付かないルート (未認証でも 200 で
 * connected:false を返すのが仕様) — 認証の適用漏れは test/api-auth.test.ts が全ルート列挙で
 * 機械的に検査している。
 */
import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import type {
  AccountDTO,
  ApiError,
  BlockRuleDeleteRequest,
  BlockRuleDTO,
  BlockRulesResponse,
  BlockRuleUpsertRequest,
  DisconnectRequest,
  McpTokenCreateRequest,
  McpTokenCreateResponse,
  McpTokenDeleteRequest,
  McpTokenDTO,
  McpTokensResponse,
  MeResponse,
  VisibleCalendarsRequest,
  WatchRequest,
} from "@kichijitsu/shared";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware";
import { SESSION_COOKIE_NAME } from "../session";
import { decryptToken, InvalidCiphertextError } from "../crypto";
import { revokeToken } from "../google/oauth";
import { SUPPORTED_SYNC_BACKFILL_VERSION } from "../core/google-events";
import {
  isAccountInProfile,
  resolveDisconnectTargets,
  shouldClearSessionAfterDisconnect,
  type AccountMembership,
} from "../accounts";
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
import { generateMcpToken, hashMcpToken } from "../mcp-token";
import { enableWatch, disableWatch } from "../watch-registration";

export const settingsRoutes = new Hono<AppEnv>();

interface WatchApiResponse {
  watching: boolean;
}

// 認証不要 (未認証なら connected:false を返す) — このファイルで唯一 requireAuth が付かないルート。
// syncBackfillVersion は「この sync が対応している同期バックフィル世代」(2026-07-25、M-5 の恒久対策)。
// web は min(自分の世代, この値) までしかバックフィル完了として記録しない — 詳細は shared の
// MeResponse.syncBackfillVersion と core/google-events.ts の SUPPORTED_SYNC_BACKFILL_VERSION 参照。
settingsRoutes.get("/api/me", async (c) => {
  const profileId = c.get("profileId");
  if (!profileId) {
    return c.json<MeResponse>({
      connected: false,
      accounts: [],
      visibleCalendars: {},
      github: null,
      syncBackfillVersion: SUPPORTED_SYNC_BACKFILL_VERSION,
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
  return c.json<MeResponse>({
    connected: accounts.length > 0,
    accounts,
    visibleCalendars,
    github,
    syncBackfillVersion: SUPPORTED_SYNC_BACKFILL_VERSION,
  });
});

// カレンダー選択をサーバーに保存する (2026-07-20、端末間同期)。対象アカウントの所属検証あり。
// 1アカウントぶんを DELETE→INSERT の全置換で書き込み、あわせて account_calendar_prefs に
// configured=1 を upsert する (「未設定」と「空選択」を区別するためのフラグ。詳細は
// migrations/0005_visible_calendars.sql と core/visible-calendars.ts のコメント参照)。
// D1 の batch は暗黙のトランザクションとして実行される。
settingsRoutes.put("/api/visible-calendars", requireAuth, async (c) => {
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
settingsRoutes.get("/api/block-rules", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  const rules = await loadBlockRules(c.env, profileId);
  return c.json<BlockRulesResponse>({ rules });
});

// id 無し=新規作成 (crypto.randomUUID() でルート側が採番)、id 有り=更新 (全置換: 該当行の
// UPDATE + block_rule_sources の DELETE→INSERT)。source/target の全 accountId がこの
// プロファイルに属していることを検証する (他人のアカウントを参照させない)。D1 の batch は
// 暗黙のトランザクションとして実行される。
settingsRoutes.post("/api/block-rules", requireAuth, async (c) => {
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

settingsRoutes.delete("/api/block-rules", requireAuth, async (c) => {
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
settingsRoutes.get("/api/mcp-tokens", requireAuth, async (c) => {
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

settingsRoutes.post("/api/mcp-tokens", requireAuth, async (c) => {
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

settingsRoutes.delete("/api/mcp-tokens", requireAuth, async (c) => {
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

// 選択中カレンダーの push 通知 (watch channel) 登録/解除。best-effort: 登録に失敗しても
// (ローカル開発の localhost address 拒否など) 200 で `{ watching: false }` を返す
// (ポーリングフォールバックが補うので、クライアントにエラー扱いさせる必要が無い)。
settingsRoutes.post("/api/watch", requireAuth, async (c) => {
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
settingsRoutes.delete("/api/account", requireAuth, async (c) => {
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
