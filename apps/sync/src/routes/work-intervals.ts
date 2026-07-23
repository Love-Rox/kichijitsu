import { Hono } from "hono";
import type { AppEnv } from "../types";
import type {
  ApiError,
  WorkIntervalRequest,
  WorkIntervalResponse,
  WorkIntervalStartRequest,
  WorkIntervalStartResponse,
  WorkIntervalStopRequest,
  WorkIntervalStopResponse,
} from "@kichijitsu/shared";
import { resolveProfileFromMcpToken } from "../mcp-auth";
import {
  buildWorkLogRow,
  insertWorkLog,
  startWorkInterval,
  stopWorkInterval,
  validateWorkIntervalStart,
  validateWorkIntervalStop,
  validateWorkLogInput,
} from "../core/work-log";

export const workIntervalsRoutes = new Hono<AppEnv>();

/**
 * Authorization: Bearer <MCP トークン> を検証して profileId を返す。不正なら null。
 * このファイル内の3経路 (完了区間の記録 / 開始 / 停止) はいずれも hook 用 (Bearer 認証) で
 * 同じ解決手順を踏むため共通化する。
 */
async function resolveBearerProfileId(env: Env, authHeader: string): Promise<string | null> {
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) return null;
  return resolveProfileFromMcpToken(env, match[1]);
}

/**
 * hook からの作業実績記録 (docs/mcp.md「エージェントの作業時間記録」)。認証は MCP トークンの
 * Bearer のみ — routes/mcp.ts と同じ理由 (非対話の hook から使うため、セッション cookie は使えない)。
 * MCP ツール log_work_interval と同じ core (core/work-log.ts) を使い D1 の work_logs へ書く。
 * Google アカウントは不要 (profileId だけで書ける) — owner アカウント解決は廃止した。
 */
workIntervalsRoutes.post("/api/work-intervals", async (c) => {
  const profileId = await resolveBearerProfileId(c.env, c.req.header("Authorization") ?? "");
  if (!profileId) {
    return c.json<ApiError>({ error: "unauthorized" }, 401);
  }

  let body: WorkIntervalRequest;
  try {
    body = await c.req.json<WorkIntervalRequest>();
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

  const validationError = validateWorkLogInput({
    startIso: body.start,
    endIso: body.end,
    repo: body.repo,
  });
  if (validationError) {
    return c.json<ApiError>({ error: validationError }, 400);
  }

  // body.timeZone は D1 保存では不要 (Date.parse が offset 込みの ISO を直接 epoch ms へ変換する)
  // だが、既存 hook との後方互換のためリクエストボディとしては受け付けたまま無視する。
  const row = buildWorkLogRow(
    crypto.randomUUID(),
    profileId,
    {
      startIso: body.start,
      endIso: body.end,
      repo: body.repo,
      branch: body.branch,
      issueRef: body.issueRef,
      agent: body.agent,
    },
    Date.now(),
  );
  await insertWorkLog(c.env, row);

  return c.json<WorkIntervalResponse>({ id: row.id }, 200);
});

/**
 * hook からの作業開始 (開区間を1本立てる、docs/mcp.md「エージェントの作業時間記録」)。認証は
 * POST /api/work-intervals と同じ MCP トークンの Bearer。core/work-log.ts の startWorkInterval を
 * 呼ぶ (MCP ツール start_work_interval と共通)。同一 (repo, issueRef) の開始中が既にあれば no-op で
 * 既存を返す (alreadyOpen: true)。start 省略時はサーバー now。
 */
workIntervalsRoutes.post("/api/work-intervals/start", async (c) => {
  const profileId = await resolveBearerProfileId(c.env, c.req.header("Authorization") ?? "");
  if (!profileId) {
    return c.json<ApiError>({ error: "unauthorized" }, 401);
  }

  let body: WorkIntervalStartRequest;
  try {
    body = await c.req.json<WorkIntervalStartRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (typeof body?.repo !== "string") {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }
  if (
    (body.issueRef !== undefined && typeof body.issueRef !== "string") ||
    (body.branch !== undefined && typeof body.branch !== "string") ||
    (body.agent !== undefined && typeof body.agent !== "string") ||
    (body.start !== undefined && typeof body.start !== "string")
  ) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  const validationError = validateWorkIntervalStart({ repo: body.repo, startIso: body.start });
  if (validationError) {
    return c.json<ApiError>({ error: validationError }, 400);
  }

  const result = await startWorkInterval(c.env, profileId, {
    repo: body.repo,
    issueRef: body.issueRef,
    branch: body.branch,
    agent: body.agent,
    startIso: body.start,
  });
  return c.json<WorkIntervalStartResponse>(result, 200);
});

/**
 * hook からの作業停止 (対応する開区間に end を書き込む、docs/mcp.md)。認証は MCP トークンの Bearer。
 * core/work-log.ts の stopWorkInterval を呼ぶ (MCP ツール stop_work_interval と共通)。対応する開始中が
 * 無い孤立停止は何も作らず 200 + { closed: false, reason: "no_open_interval" } を返す (誤った 0分記録を
 * 作らない)。end 省略時はサーバー now。
 */
workIntervalsRoutes.post("/api/work-intervals/stop", async (c) => {
  const profileId = await resolveBearerProfileId(c.env, c.req.header("Authorization") ?? "");
  if (!profileId) {
    return c.json<ApiError>({ error: "unauthorized" }, 401);
  }

  let body: WorkIntervalStopRequest;
  try {
    body = await c.req.json<WorkIntervalStopRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (typeof body?.repo !== "string") {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }
  if (
    (body.issueRef !== undefined && typeof body.issueRef !== "string") ||
    (body.end !== undefined && typeof body.end !== "string")
  ) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  const validationError = validateWorkIntervalStop({ repo: body.repo, endIso: body.end });
  if (validationError) {
    return c.json<ApiError>({ error: validationError }, 400);
  }

  const result = await stopWorkInterval(c.env, profileId, {
    repo: body.repo,
    issueRef: body.issueRef,
    endIso: body.end,
  });
  return c.json<WorkIntervalStopResponse>(result, 200);
});
