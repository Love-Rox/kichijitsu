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
import { denyUnlessAccountInProfile, INVALID_JSON, readJsonBody } from "./guards";
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
  resolveDeleteMirrors,
  shouldDiscardMirrorRows,
  type BlockRuleRow,
} from "../core/block-rules";
import { deleteRuleMirrors, type MirrorDeleteDeps } from "../core/block-orchestrate";
import type { BlockMirrorRow } from "../core/block-reconcile";
import { disconnectAccounts, type DisconnectDeps } from "../core/account-disconnect";
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
  const body = await readJsonBody<VisibleCalendarsRequest>(c);
  if (body === INVALID_JSON) return c.json<ApiError>({ error: "invalid_json" }, 400);
  if (!isValidVisibleCalendarsRequest(body)) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  const denied = await denyUnlessAccountInProfile(c, body.accountId);
  if (denied) return denied;

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
  const body = await readJsonBody<BlockRuleUpsertRequest>(c);
  if (body === INVALID_JSON) return c.json<ApiError>({ error: "invalid_json" }, 400);
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
  // あわせて既存の target も読む — 変わっていれば block_mirrors の行を捨てる必要がある
  // (shouldDiscardMirrorRows のコメント参照)。
  let existingOooFallback = false;
  let discardMirrorRows = false;
  if (body.id) {
    const existing = await c.env.DB.prepare(
      "SELECT profile_id, ooo_fallback, target_account_id, target_calendar_id FROM block_rules WHERE id = ?",
    )
      .bind(body.id)
      .first<{
        profile_id: string;
        ooo_fallback: number;
        target_account_id: string;
        target_calendar_id: string;
      }>();
    if (!isAccountInProfile(existing, profileId)) {
      // 存在しない id と「他人のプロファイルの id」を区別せず 403 にする (他のエンドポイントと同じ方針)。
      return c.json<ApiError>({ error: "rule_not_found" }, 403);
    }
    existingOooFallback = existing?.ooo_fallback === 1;
    discardMirrorRows = shouldDiscardMirrorRows(
      existing
        ? { accountId: existing.target_account_id, calendarId: existing.target_calendar_id }
        : null,
      body.target,
    );
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
    // target が変わったら対応表を捨てる。古い target の event id を新しい target に対して
    // patch/delete しにいって 404 になるのを防ぐ (shouldDiscardMirrorRows のコメント参照)。
    // 古い target に残るミラー予定は消さない — 利用者が明示的に選んだときだけ Google 上の
    // 予定を消す原則 (docs/blocking.md「後始末」)。
    ...(discardMirrorRows
      ? [c.env.DB.prepare("DELETE FROM block_mirrors WHERE rule_id = ?").bind(ruleId)]
      : []),
  ]);

  return c.json<BlockRuleDTO>({
    id: ruleId,
    sources: sourceRows.map((row) => ({ accountId: row.account_id, calendarId: row.calendar_id })),
    target: { accountId: ruleRow.target_account_id, calendarId: ruleRow.target_calendar_id },
    mode: ruleRow.mode,
    oooFallback: body.id ? existingOooFallback : false,
  });
});

// deleteMirrors:true のときだけ、Google 側に作った「予定あり」のミラー予定も消す
// (省略時は false = 消さない、理由は core/block-rules.ts の resolveDeleteMirrors)。
// Google の削除は best-effort — 1件失敗しても残りを続け、ルール行の削除は必ず行う
// (「予定が消せないせいでルールも消せない」状態に利用者を閉じ込めないため)。
settingsRoutes.delete("/api/block-rules", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  const body = await readJsonBody<BlockRuleDeleteRequest>(c);
  if (body === INVALID_JSON) return c.json<ApiError>({ error: "invalid_json" }, 400);
  if (!isValidBlockRuleDeleteRequest(body)) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  const existing = await c.env.DB.prepare(
    "SELECT profile_id, target_account_id, target_calendar_id FROM block_rules WHERE id = ?",
  )
    .bind(body.id)
    .first<{ profile_id: string; target_account_id: string; target_calendar_id: string }>();
  if (!isAccountInProfile(existing, profileId)) {
    return c.json<ApiError>({ error: "rule_not_found" }, 403);
  }

  if (existing && resolveDeleteMirrors(body)) {
    // 失敗しても下の行削除には進む (best-effort)。Google の呼び出し全体が落ちても同様。
    try {
      const mirrors = await loadBlockMirrors(c.env, body.id);
      const result = await deleteRuleMirrors(
        body.id,
        { accountId: existing.target_account_id, calendarId: existing.target_calendar_id },
        mirrors,
        buildMirrorDeleteDeps(c.env),
      );
      if (result.failed > 0) {
        console.warn(
          `block rule deletion: ${result.failed} of ${mirrors.length} mirror events could not be deleted for rule ${body.id}`,
        );
      }
    } catch (err) {
      console.warn(`block rule deletion: mirror cleanup failed for rule ${body.id}`, err);
    }
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
  const body = await readJsonBody<McpTokenCreateRequest>(c);
  if (body === INVALID_JSON) return c.json<ApiError>({ error: "invalid_json" }, 400);

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
  const body = await readJsonBody<McpTokenDeleteRequest>(c);
  if (body === INVALID_JSON) return c.json<ApiError>({ error: "invalid_json" }, 400);
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
  const body = await readJsonBody<WatchRequest>(c);
  if (body === INVALID_JSON) return c.json<ApiError>({ error: "invalid_json" }, 400);
  if (!body?.accountId || !body?.calendarId || typeof body.enabled !== "boolean") {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  const denied = await denyUnlessAccountInProfile(c, body.accountId);
  if (denied) return denied;

  if (!body.enabled) {
    await disableWatch(c.env, body.accountId, body.calendarId);
    return c.json<WatchApiResponse>({ watching: false });
  }

  const watching = await enableWatch(c.env, body.accountId, body.calendarId, profileId);
  return c.json<WatchApiResponse>({ watching });
});

// 連携解除 (アカウント削除)。accountId 指定ならそのアカウントだけ、省略ならプロファイル内
// 全アカウントを対象にする。対象ごとに: watch stop → revoke → DO 状態クリア → D1 行削除、
// の順で実行し、最後に解除された全アカウントを踏まえてブロックルールを掃除する
// (順序の理由と best-effort の方針は core/account-disconnect.ts のコメント参照)。
// 最後にプロファイルのアカウントが 0 件になった時だけセッション (sid cookie) も破棄する。
settingsRoutes.delete("/api/account", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;

  // ここだけ guards.ts の readJsonBody を使わない ―― **ボディ無し (accountId 省略 =
  // 全アカウント解除) を許す**唯一のルートで、空文字と壊れた JSON を区別する必要があるため。
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

  await disconnectAccounts(targets, buildDisconnectDeps(c.env, profileId));

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

/**
 * DELETE /api/account の後始末に、この worker の D1 / Google / DO を割り当てる。
 * 判断と順序 (watch stop → revoke → DO クリア → 行削除、最後にブロックルール掃除) は
 * core/account-disconnect.ts 側にあり、ここは各操作の実装だけを持つ。
 */
function buildDisconnectDeps(env: Env, profileId: string): DisconnectDeps {
  return {
    listWatches: async (accountId) => {
      const { results } = await env.DB.prepare(
        "SELECT channel_id, calendar_id FROM watches WHERE account_id = ?",
      )
        .bind(accountId)
        .all<{ channel_id: string; calendar_id: string }>();
      return results.map((row) => ({ channelId: row.channel_id, calendarId: row.calendar_id }));
    },
    // POST /api/watch (enabled:false) と同じ実装を再利用する (channels.stop → watches 行削除、
    // Google 側の停止に失敗してもローカル行は消す)。
    stopWatch: (accountId, watch) => disableWatch(env, accountId, watch.calendarId),
    revokeToken: async (accountId) => {
      const row = await env.DB.prepare("SELECT refresh_token FROM accounts WHERE id = ?")
        .bind(accountId)
        .first<{ refresh_token: string }>();
      if (!row) return;

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
    },
    clearSyncState: async (accountId) => {
      const stub = env.USER_SYNC.getByName(accountId);
      const clearResult = await stub.clearSyncState();
      if (!clearResult.ok) {
        console.warn(
          `account deletion: failed to clear DO sync state for account ${accountId}: ${clearResult.error}`,
        );
      }
    },
    deleteAccountRows: async (accountId) => {
      // watches はここまでの stopWatch で消えているはずだが、stop 前に行取得が失敗した場合や
      // 途中で増えた行が残らないよう、account_id 単位でも必ず消す (行が残ると Cron の
      // renewWatch が存在しないアカウントの watch を延々と再登録しようとする)。
      await env.DB.batch([
        env.DB.prepare("DELETE FROM watches WHERE account_id = ?").bind(accountId),
        env.DB.prepare("DELETE FROM account_visible_calendars WHERE account_id = ?").bind(accountId),
        env.DB.prepare("DELETE FROM account_calendar_prefs WHERE account_id = ?").bind(accountId),
        env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(accountId),
      ]);
    },
    loadBlockRules: async () => {
      const rules = await loadBlockRules(env, profileId);
      return rules.map((rule) => ({
        id: rule.id,
        targetAccountId: rule.target.accountId,
        sources: rule.sources,
      }));
    },
    applyBlockRuleCleanup: async (plan) => {
      const statements = [
        ...plan.ruleIdsToDelete.flatMap((ruleId) => [
          env.DB.prepare("DELETE FROM block_rules WHERE id = ?").bind(ruleId),
          env.DB.prepare("DELETE FROM block_rule_sources WHERE rule_id = ?").bind(ruleId),
          // block_mirrors 行だけを消す (Google 側に作られたミラー予定は消さない) — DELETE
          // /api/block-rules で deleteMirrors を外したときと同じ扱い。**target のアカウントが
          // 生きていれば技術的には消せる** (source を全部解除してルールが消える場合がこれ) が、
          // 解除には「作成済みのブロック予定も消しますか」を聞ける瞬間が無いので消さない
          // — 原則「Google 上の予定を消すのは利用者が明示的に選んだときだけ」(docs/blocking.md
          // 「後始末」)。target ごと解除された場合は加えて認可も無く、そもそも消せない。
          // 生き残るルールのミラーが解除直後に消えるのとの違いは、core/account-disconnect.ts の
          // planReconcileTriggers「原則との関係」を参照。
          env.DB.prepare("DELETE FROM block_mirrors WHERE rule_id = ?").bind(ruleId),
        ]),
        ...plan.sourcesToDetach.map((source) =>
          env.DB.prepare(
            "DELETE FROM block_rule_sources WHERE rule_id = ? AND account_id = ? AND calendar_id = ?",
          ).bind(source.ruleId, source.accountId, source.calendarId),
        ),
      ];
      await env.DB.batch(statements);
    },
    // 残っている source カレンダーが変わったことにしてリコンサイルを起こす。webhook 経路
    // (routes/webhook.ts) とまったく同じ RPC で、ProfileHubDO 側が waitUntil で実行するので
    // ここではすぐ返る。SSE 接続中のクライアントにもこの calendarId の changed が届くが、
    // 受け取った側は同期し直すだけなので害は無い。
    reconcileFromSource: async (trigger) => {
      const stub = env.PROFILE_HUB.getByName(profileId);
      await stub.notifyChanged(trigger.accountId, trigger.calendarId, profileId);
    },
  };
}

/** DELETE /api/block-rules (deleteMirrors:true) 用: そのルールが作った mirror の対応表を全件引く。 */
async function loadBlockMirrors(env: Env, ruleId: string): Promise<BlockMirrorRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT rule_id, source_event_id, mirror_event_id, source_updated, created_at FROM block_mirrors WHERE rule_id = ?",
  )
    .bind(ruleId)
    .all<BlockMirrorRow>();
  return results;
}

/**
 * DELETE /api/block-rules (deleteMirrors:true) のミラー削除に、この worker の DO RPC を割り当てる。
 * 削除の順序と best-effort の扱いは core/block-orchestrate.ts の deleteRuleMirrors 側にある
 * (ProfileHubDO のリコンサイルと同じ実装を共有する)。
 */
function buildMirrorDeleteDeps(env: Env): MirrorDeleteDeps {
  return {
    // ProfileHubDO.deleteMirror と同じ RPC。target アカウントの UserSyncDO が
    // access token の更新とリトライを持つ。
    deleteMirror: async (targetAccountId, targetCalendarId, mirrorEventId) => {
      const stub = env.USER_SYNC.getByName(targetAccountId);
      const result = await stub.deleteEvent(targetAccountId, targetCalendarId, mirrorEventId);
      if (!result.ok) {
        throw new Error(
          `deleteEvent failed for account=${targetAccountId} calendar=${targetCalendarId}: status=${result.status} ${result.error}`,
        );
      }
    },
    // この経路では対応表の行を1件ずつ消す必要が無い — 直後の batch が rule_id 単位で
    // block_mirrors を丸ごと消す (ルール自体が無くなるので行を残す意味も無い)。
    deleteMirrorRow: async () => {},
  };
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
