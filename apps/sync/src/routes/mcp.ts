import { Hono } from "hono";
import type { AppEnv } from "../types";
import { resolveProfileFromMcpToken } from "../mcp-auth";
import { KichijitsuMcpAgent, type McpProps } from "../durable-object/mcp-agent";

export const mcpRoutes = new Hono<AppEnv>();

mcpRoutes.all("/mcp", async (c) => {
  const authHeader = c.req.header("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const profileId = await resolveProfileFromMcpToken(c.env, match[1]);
  if (!profileId) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const ctx = c.executionCtx;
  // McpAgent (Cloudflare Agents SDK) reads custom auth identity from ExecutionContext.props —
  // the same mechanism @cloudflare/workers-oauth-provider uses, see agents' own
  // packages/agents/src/tests/worker.ts fixture for the identical pattern. We set it ourselves
  // since we're not using the full OAuthProvider (we already have our own Bearer token issued
  // via docs/mcp.md Part A / mcp-token.ts). Hono's own `ExecutionContext` type (what
  // `c.executionCtx` returns) declares `props: any` (mutable, no readonly) specifically "for
  // compatibility with Wrangler 4.x", so no cast/suppression is needed for this assignment —
  // only for handing `ctx` to McpAgent.serve() below, which expects the ambient (generated)
  // `ExecutionContext` type with a `tracing` field Hono's narrower type doesn't declare. At
  // runtime this is the same real ExecutionContext object Cloudflare passed to fetch(), so the
  // cast is safe.
  ctx.props = { profileId } satisfies McpProps;

  return KichijitsuMcpAgent.serve("/mcp", { binding: "KICHIJITSU_MCP" }).fetch(
    c.req.raw,
    c.env,
    ctx as unknown as ExecutionContext,
  );
});
