/**
 * **ロールバックした旨のフラッシュ表示** (ツールバーの「保存失敗(元に戻しました)」) だけを
 * 担当する (useEventMutations から分割、2026-07-31)。
 *
 * 純粋な表示 state だが、立てるのは変更系のロールバック経路 (移動確定・新規作成・削除・
 * タスクのトグル) だけなので、変更系フックの内側に置いてある。ツールバーの同期ステータスと
 * 同じ流儀で数秒だけ出して消す。
 *
 * useEventMutations が登録する effect はここの「アンマウント時にタイマーを片付ける」1本だけ
 * ―― 依存が [] なので登録順に敏感ではないが、App.tsx での呼び出し位置を移設前から
 * 動かしていない理由がこれ (useEventMutations 冒頭のコメント参照)。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export function useSaveErrorFlash(): { saveError: boolean; flashSaveError: () => void } {
  // Google への書き戻し (POST /api/event/patch) 失敗時のロールバック通知
  // (フェーズ5)。syncStatus とは別軸: こちらはドラッグ確定1件ごとの結果
  const [saveError, setSaveError] = useState(false);
  const saveErrorTimeoutRef = useRef<number | undefined>(undefined);

  // 保存失敗の通知を数秒間表示してから消す(ツールバーの同期ステータスの流儀に倣う)
  const flashSaveError = useCallback(() => {
    if (saveErrorTimeoutRef.current !== undefined) {
      window.clearTimeout(saveErrorTimeoutRef.current);
    }
    setSaveError(true);
    saveErrorTimeoutRef.current = window.setTimeout(() => {
      setSaveError(false);
      saveErrorTimeoutRef.current = undefined;
    }, 4000);
  }, []);

  useEffect(() => {
    return () => {
      if (saveErrorTimeoutRef.current !== undefined)
        window.clearTimeout(saveErrorTimeoutRef.current);
    };
  }, []);

  return { saveError, flashSaveError };
}
