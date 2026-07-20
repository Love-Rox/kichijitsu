import type { McpTokenDTO } from "@kichijitsu/shared";

/**
 * MCP トークン管理 UI (docs/mcp.md Part A、2026-07-20) 用の表示整形ヘルパー。
 * blockRules.ts / visibleCalendars.ts と同じ流儀 — fetch や副作用は持たない純関数のみ。
 * 実際の GET/POST/DELETE /api/mcp-tokens 呼び出しは App.tsx (checkedFetch 経由) が行う。
 */

/** label が無い(null/空文字)トークンの一覧表示用プレースホルダ */
export function mcpTokenLabel(token: Pick<McpTokenDTO, "label">): string {
  return token.label && token.label.length > 0 ? token.label : "(無題)";
}

/** 最終利用日時の表示。未使用 (lastUsedAt === null) なら「未使用」 */
export function mcpTokenLastUsedLabel(token: Pick<McpTokenDTO, "lastUsedAt">): string {
  return token.lastUsedAt === null ? "未使用" : new Date(token.lastUsedAt).toLocaleString();
}
