import { Hono } from "hono";
import { createMcpHandler } from "agents/mcp/server";
import type { AppEnv } from "../types";
import { resolveProfileFromMcpToken } from "../mcp-auth";
import { isAllowedMcpOrigin } from "../mcp-origin";
import { createKichijitsuMcpServer } from "../mcp-server";

export const mcpRoutes = new Hono<AppEnv>();

mcpRoutes.all("/mcp", async (c) => {
  // DNS リバインディング対策 (MCP Streamable HTTP の MUST)。認証より先に弾く —
  // 不正オリジンからのリクエストはトークンの正否以前に処理してはならない。
  // Origin を送らない非ブラウザクライアント (Claude 等) は素通りする (mcp-origin.ts 参照)。
  if (!isAllowedMcpOrigin(c.req.header("Origin"), c.req.url)) {
    return c.json({ error: "forbidden_origin" }, 403);
  }

  const authHeader = c.req.header("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const profileId = await resolveProfileFromMcpToken(c.env, match[1]);
  if (!profileId) {
    return c.json({ error: "unauthorized" }, 401);
  }

  // MCP SDK v2 の factory は (env, profileId) をクロージャで受け取る。createMcpHandler は
  // リクエストごとに factory を呼ぶ設計なので、認証済みの profileId をここで閉じ込めて
  // しまうのが最も素直 (agents の getMcpAuthContext() / AsyncLocalStorage を経由しなくて済む)。
  const handler = createMcpHandler(() => createKichijitsuMcpServer(c.env, profileId), {
    route: "/mcp",
    // legacy: "stateless" (既定) が initialize 世代 (〜2025-11-25) のクライアントを
    // 受け持ち、新世代 (2026-07-28、_meta エンベロープ + server/discover) は本体が捌く。
    // 設定済みの既存クライアントを壊さないため、明示的に既定のまま残す。
    legacy: "stateless",
    // Origin 検証は上の isAllowedMcpOrigin で既に済ませている (このハンドラの手前で動く
    // 信頼できるミドルウェア)。ハンドラ側の既定の許可リストは localhost と workers.dev
    // しか含まず、本番のカスタムドメイン (kichijitsu.love-rox.cc) からの正当な
    // ブラウザリクエストを弾いてしまうため "*" で明示的に無効化する。
    // ⚠ この "*" は isAllowedMcpOrigin とセットで初めて安全になる —
    // 不正形式/opaque(null)/別オリジンの拒否はあちらが担保している。片方だけ消さないこと。
    allowedOriginHostnames: "*",
  });

  return handler.fetch(c.req.raw);
});
