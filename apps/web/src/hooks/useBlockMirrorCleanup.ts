import { useCallback, useState } from "react";
import type {
  BlockMirrorCleanupItem,
  BlockMirrorCleanupRequest,
  BlockMirrorCleanupResponse,
  BlockMirrorOrphansResponse,
  BlockMirrorScanEntry,
  OrphanMirrorDTO,
} from "@kichijitsu/shared";
import {
  applyCleanupResult,
  type BlockMirrorFailedDetail,
} from "../sync/blockMirrorCleanup";
import { getJson, postJson, type CheckedFetch } from "../sync/httpJson";

/**
 * 「残ったブロック予定を掃除する」オーバーレイ (docs/blocking.md「将来やるならこれ」) の
 * 走査/削除 state と、その GET/POST 呼び出しだけを持つフック。useBlockRules.ts と同じ役割分担
 * ―― リクエスト整形・応答の反映計算は sync/blockMirrorCleanup.ts の純関数が持ち、
 * ここは「いつ叩くか」と state の更新規則だけを担う。
 *
 * useBlockRules.ts と違い connected になった時点での自動取得は無い ―― ここは
 * 「明示的な操作で開始する」ことが要件そのもの(全カレンダーを叩く重い走査を、設定モーダルを
 * 開くたび・オーバーレイを開くたびに自動実行しない)。呼び出し元 (BlockMirrorCleanupOverlay) の
 * ボタン押下からのみ scan() を呼ぶ。
 */

export type BlockMirrorScanState = "idle" | "scanning" | "done" | "error";

export interface BlockMirrorCleanupController {
  scanState: BlockMirrorScanState;
  scanned: BlockMirrorScanEntry[];
  orphans: OrphanMirrorDTO[];
  /** 直前の cleanup() で削除できなかった行(理由付き)。次の scan()/cleanup() で上書きされる */
  lastFailures: BlockMirrorFailedDetail[];
  /** 「残ったブロック予定を探す」ボタンから呼ぶ。失敗時は scanState を "error" にし、例外は投げない
   * (オーバーレイを開いたまま再試行できるようにするため。作成/削除系の throw する流儀とは違う) */
  scan: () => Promise<void>;
  /** 選択済み行の削除確定から呼ぶ。fetch 自体の失敗(非2xx・ネットワークエラー)は throw する
   * (呼び出し元がエラー表示を出す、useBlockRules.deleteBlockRule と同じ流儀)。
   * 個々の予定単位の失敗は throw せず lastFailures に載る(サーバーの応答どおり) */
  cleanup: (items: BlockMirrorCleanupItem[]) => Promise<void>;
}

export function useBlockMirrorCleanup({
  checkedFetch,
}: {
  checkedFetch: CheckedFetch;
}): BlockMirrorCleanupController {
  const [scanState, setScanState] = useState<BlockMirrorScanState>("idle");
  const [scanned, setScanned] = useState<BlockMirrorScanEntry[]>([]);
  const [orphans, setOrphans] = useState<OrphanMirrorDTO[]>([]);
  const [lastFailures, setLastFailures] = useState<BlockMirrorFailedDetail[]>([]);

  const scan = useCallback(async () => {
    setScanState("scanning");
    // 走査中は直前の結果を画面に残す(消してしまうと再走査のたびに一覧が一瞬空になり、
    // 「もう孤児は無くなった」と誤読されうるため)。lastFailures だけは新しい走査の結果に
    // 意味を持たない古い情報になるのでここで消す。
    setLastFailures([]);
    try {
      const data = await getJson<BlockMirrorOrphansResponse>(
        checkedFetch,
        "/api/block-mirrors/orphans",
      );
      setScanned(data.scanned);
      setOrphans(data.orphans);
      setScanState("done");
    } catch (err) {
      console.error("kichijitsu: GET /api/block-mirrors/orphans failed", err);
      setScanState("error");
    }
  }, [checkedFetch]);

  const cleanup = useCallback(
    async (items: BlockMirrorCleanupItem[]) => {
      const response = await postJson<BlockMirrorCleanupRequest, BlockMirrorCleanupResponse>(
        checkedFetch,
        "/api/block-mirrors/cleanup",
        { items },
      );
      const { remaining, failedDetails } = applyCleanupResult(orphans, items, response, scanned);
      setOrphans(remaining);
      setLastFailures(failedDetails);
    },
    [checkedFetch, orphans, scanned],
  );

  return { scanState, scanned, orphans, lastFailures, scan, cleanup };
}
