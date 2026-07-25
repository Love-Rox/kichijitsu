import { useCallback, useEffect, useState } from "react";
import type { BlockRuleDTO, BlockRuleUpsertRequest, BlockRulesResponse } from "@kichijitsu/shared";
import { buildBlockRuleDeleteRequest } from "../sync/blockRules";
import { deleteJson, postJson, type CheckedFetch } from "../sync/httpJson";

/**
 * カレンダーブロック設定 (docs/blocking.md、フェーズ7 第1段階) のルール一覧 state と
 * その取得・作成/更新・削除だけを持つフック。
 *
 * なぜ切り出したか(リファクタリング フェーズ2 ②、2026-07-25): App.tsx にあったこの塊は
 * 「state + 取得 + 作成/削除ハンドラ」が揃った小さな閉じた単位で、外部依存は checkedFetch
 * (オフライン判定を挟む fetch ラッパー、hooks/useOffline.ts)だけだった。
 * リクエストボディの組み立てと一覧表示用の整形は sync/blockRules.ts の純関数が持つ
 * (この層は「いつ取りに行くか」と state の更新規則だけを担う)。
 */

/**
 * 作成/更新のレスポンス(saved)を一覧へ反映する。同じ id が既にあれば置き換え、
 * 無ければ末尾に追加する ―― POST /api/block-rules は id 無し=新規作成・有り=更新の
 * 両対応なので、応答だけを見て一覧をそのまま更新できるようにしてある。
 * 引数の配列は変更せず、常に新しい配列を返す(React state 用、layout/setOps.ts と同じ流儀)。
 */
export function upsertBlockRule(prev: BlockRuleDTO[], saved: BlockRuleDTO): BlockRuleDTO[] {
  const idx = prev.findIndex((r) => r.id === saved.id);
  if (idx === -1) return [...prev, saved];
  const next = [...prev];
  next[idx] = saved;
  return next;
}

export interface BlockRulesController {
  /** ルール一覧(サーバーが正。connected になった時点で一度だけ取得する) */
  blockRules: BlockRuleDTO[];
  /** BlockRulesOverlay の作成フォームから呼ぶ。失敗時は throw する */
  createBlockRule: (req: BlockRuleUpsertRequest) => Promise<void>;
  /** BlockRulesOverlay の一覧の削除ボタンから呼ぶ。失敗時は throw する */
  deleteBlockRule: (id: string) => Promise<void>;
}

/**
 * @param connected アカウント連携済みか(me.connected)。未連携の間は取得しない
 * @param checkedFetch オフライン判定を挟む fetch ラッパー(App.tsx の checkedFetch)
 */
export function useBlockRules({
  connected,
  checkedFetch,
}: {
  connected: boolean;
  checkedFetch: CheckedFetch;
}): BlockRulesController {
  // ルール一覧はサーバーが正 — connected になったら一度だけ取得する(下の useEffect)
  const [blockRules, setBlockRules] = useState<BlockRuleDTO[]>([]);

  // カレンダーブロックのルール一覧を取得する(docs/blocking.md)。アカウント連携が無い間は
  // 意味を持たないため me.connected になってから引く。checkMe と同じ流儀で
  // 非 2xx・ネットワークエラーはコンソールを汚さない程度に warn するだけに留める
  // (このオーバーレイは未接続では開けないので、失敗しても致命的ではない)
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    checkedFetch("/api/block-rules")
      .then(async (res) => {
        if (!res.ok) {
          console.warn(`kichijitsu: GET /api/block-rules failed: ${res.status}`);
          return;
        }
        const data = (await res.json()) as BlockRulesResponse;
        if (!cancelled) setBlockRules(data.rules);
      })
      .catch((err) => {
        console.warn("kichijitsu: GET /api/block-rules failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, checkedFetch]);

  // BlockRulesOverlay の作成フォームから呼ぶ。id 無し=新規作成、有り=更新(今回の UI からは
  // 常に新規作成のみ使うが、将来の編集導線のためリクエストは仕様通り両対応で扱う)。
  // 失敗時は throw してオーバーレイ側(呼び出し元)にエラー表示を委ねる
  const createBlockRule = useCallback(
    async (req: BlockRuleUpsertRequest) => {
      const saved = await postJson<BlockRuleUpsertRequest, BlockRuleDTO>(
        checkedFetch,
        "/api/block-rules",
        req,
      );
      setBlockRules((prev) => upsertBlockRule(prev, saved));
    },
    [checkedFetch],
  );

  // BlockRulesOverlay のルール一覧の削除ボタンから呼ぶ。204 で成功、失敗時は throw して
  // オーバーレイ側にエラー表示を委ねる(行ごとの確認 UI は持たない、削除は即時実行)
  const deleteBlockRule = useCallback(
    async (id: string) => {
      await deleteJson(checkedFetch, "/api/block-rules", buildBlockRuleDeleteRequest(id));
      setBlockRules((prev) => prev.filter((r) => r.id !== id));
    },
    [checkedFetch],
  );

  return { blockRules, createBlockRule, deleteBlockRule };
}
