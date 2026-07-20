import { Hono } from "hono";
import type { AppEnv } from "../types";
import type { ApiError, WorkIntervalRequest, WorkIntervalResponse } from "@kichijitsu/shared";
import { resolveProfileFromMcpToken } from "../mcp-auth";
import { buildWorkLogRow, insertWorkLog, validateWorkLogInput } from "../core/work-log";

export const workIntervalsRoutes = new Hono<AppEnv>();

/**
 * hook からの作業実績記録 (docs/mcp.md「エージェントの作業時間記録」)。認証は MCP トークンの
 * Bearer のみ — routes/mcp.ts と同じ理由 (非対話の hook から使うため、セッション cookie は使えない)。
 * MCP ツール log_work_interval と同じ core (core/work-log.ts) を使い D1 の work_logs へ書く。
 * Google アカウントは不要 (profileId だけで書ける) — owner アカウント解決は廃止した。
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
