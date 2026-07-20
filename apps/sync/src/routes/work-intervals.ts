import { Hono } from "hono";
import type { AppEnv } from "../types";
import type { ApiError, WorkIntervalRequest, WorkIntervalResponse } from "@kichijitsu/shared";
import { resolveProfileFromMcpToken } from "../mcp-auth";
import { resolveMcpOwnerAccountId } from "../mcp-calendars";
import { validateWorkLogInput } from "../core/work-log";

export const workIntervalsRoutes = new Hono<AppEnv>();

/**
 * hook からの作業実績記録 (docs/mcp.md「エージェントの作業時間記録」)。認証は MCP トークンの
 * Bearer のみ — routes/mcp.ts と同じ理由 (非対話の hook から使うため、セッション cookie は使えない)。
 * MCP ツール log_work_interval と同じ UserSyncDO.logWorkInterval RPC を呼ぶ。
 */
workIntervalsRoutes.post("/api/work-intervals", async (c) => {
  const authHeader = c.req.header("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) {
    return c.json<ApiError>({ error: "unauthorized" }, 401);
  }
  const profileId = await resolveProfileFromMcpToken(c.env, match[1]);
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

  const accountId = await resolveMcpOwnerAccountId(c.env, profileId);
  if (!accountId) {
    return c.json<ApiError>({ error: "account_not_found" }, 403);
  }

  const stub = c.env.USER_SYNC.getByName(accountId);
  const result = await stub.logWorkInterval(accountId, {
    startIso: body.start,
    endIso: body.end,
    repo: body.repo,
    branch: body.branch,
    issueRef: body.issueRef,
    agent: body.agent,
    timeZone: body.timeZone,
  });
  if (!result.ok) {
    console.warn(
      `work interval log failed: account=${accountId} status=${result.status} error=${result.error}`,
    );
    return c.json<ApiError>({ error: "work_interval_failed" }, 502);
  }

  return c.json<WorkIntervalResponse>(result.data, 200);
});
