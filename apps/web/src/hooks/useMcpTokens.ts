import { useCallback, useEffect, useState } from "react";
import type {
  McpTokenCreateRequest,
  McpTokenCreateResponse,
  McpTokenDeleteRequest,
  McpTokenDTO,
  McpTokensResponse,
} from "@kichijitsu/shared";
import { deleteJson, postJson, type CheckedFetch } from "../sync/httpJson";

/**
 * MCP トークン一覧 (docs/mcp.md Part A、2026-07-20) の state と発行/失効だけを持つフック。
 *
 * なぜ切り出したか(リファクタリング フェーズ2 ②、2026-07-25): useBlockRules と同じ
 * 「state + 取得 + 作成/削除」の小さな閉じた単位で、外部依存は checkedFetch だけ。
 *
 * サーバーが正 (IndexedDB には入れない、GitHub 連携メタと同じくエフェメラルな設定パネル用
 * state)。取得のタイミングは「設定パネルが開いた瞬間」に限る ―― 下の effect の依存を
 * panelOpen に絞ってあるのが要点で、開いている間の再レンダーごとに取り直さない。
 */

export interface McpTokensController {
  /** トークン一覧(生トークンは含まない。発行直後の1回だけ createMcpToken の戻り値に乗る) */
  mcpTokens: McpTokenDTO[];
  /** 設定パネルの「トークンを発行」から呼ぶ。生トークン込みの応答をそのまま返す */
  createMcpToken: (label: string | undefined) => Promise<McpTokenCreateResponse>;
  /** 設定パネルの行ごとの「失効」確定から呼ぶ。失敗時は throw する */
  deleteMcpToken: (id: string) => Promise<void>;
}

/**
 * @param panelOpen 設定モーダルが開いているか。true になった瞬間だけ一覧を取り直す
 * @param checkedFetch オフライン判定を挟む fetch ラッパー(App.tsx の checkedFetch)
 */
export function useMcpTokens({
  panelOpen,
  checkedFetch,
}: {
  panelOpen: boolean;
  checkedFetch: CheckedFetch;
}): McpTokensController {
  const [mcpTokens, setMcpTokens] = useState<McpTokenDTO[]>([]);

  // MCP トークン一覧の取得 (docs/mcp.md Part A、2026-07-20)。サーバーが正なので、設定パネルを
  // 開いたときに毎回取り直す(カレンダー再フェッチの effect と同じ「panelOpen が true になった
  // 瞬間にのみ」流儀)。失敗しても致命的ではないので warn のみに留める(block-rules と同じ)
  useEffect(() => {
    if (!panelOpen) return;
    let cancelled = false;
    checkedFetch("/api/mcp-tokens")
      .then(async (res) => {
        if (!res.ok) {
          console.warn(`kichijitsu: GET /api/mcp-tokens failed: ${res.status}`);
          return;
        }
        const data = (await res.json()) as McpTokensResponse;
        if (!cancelled) setMcpTokens(data.tokens);
      })
      .catch((err) => {
        console.warn("kichijitsu: GET /api/mcp-tokens failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [panelOpen, checkedFetch]);

  // MCP トークン発行。設定パネルの「トークンを発行」から呼ぶ。
  // レスポンスに生トークンが乗るのはこの一度きり — ここでは McpTokenDTO 相当分だけを
  // mcpTokens state に積み、生値はそのまま呼び出し元(設定パネル)へ返して表示を委ねる
  // (パネル側がローカル state として持ち、「閉じる」でのみ消える)。失敗時は throw する。
  const createMcpToken = useCallback(
    async (label: string | undefined): Promise<McpTokenCreateResponse> => {
      const created = await postJson<McpTokenCreateRequest, McpTokenCreateResponse>(
        checkedFetch,
        "/api/mcp-tokens",
        { label },
      );
      setMcpTokens((prev) => [
        ...prev,
        { id: created.id, label: created.label, createdAt: created.createdAt, lastUsedAt: null },
      ]);
      return created;
    },
    [checkedFetch],
  );

  // MCP トークン失効。設定パネルの行ごとの「失効」確定から呼ぶ。
  // 204 で成功、失敗時は throw してパネル側の行ごとの確認 UI にエラー表示を委ねる
  // (deleteBlockRule と同じ流儀)
  const deleteMcpToken = useCallback(
    async (id: string) => {
      await deleteJson(checkedFetch, "/api/mcp-tokens", { id } satisfies McpTokenDeleteRequest);
      setMcpTokens((prev) => prev.filter((t) => t.id !== id));
    },
    [checkedFetch],
  );

  return { mcpTokens, createMcpToken, deleteMcpToken };
}
