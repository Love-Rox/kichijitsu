import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { formatDetailDateTime } from "../layout/gridMetrics";
import type { Occurrence } from "../model/types";
import "./MoveConfirmDialog.css";

export interface MoveConfirmDialogProps {
  title: string;
  previous: Occurrence;
  updated: Occurrence;
  timeZone: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * ドラッグ移動の確認ダイアログ(フェーズ2、2026-07-22)。WeekGrid 上でイベントを
 * ドラッグ移動 (kind==='move') すると楽観的に見た目だけ即座に動く(store.update 済み)が、
 * まだ IndexedDB/Google への書き込みは行っていない状態でこのダイアログを挟む。
 * 「移動する」で App.tsx の handlePersist(従来のドラッグ確定処理)を呼び、
 * 「キャンセル」で previous を store.update するだけで元の位置に戻せる
 * (sync/moveConfirm.ts のコメント参照)。
 *
 * BlockRulesOverlay.tsx と同じ画面中央のバックドロップ+カード構成。キーボード
 * Enter=移動する/Esc=キャンセル(要件どおり)。
 */
export function MoveConfirmDialog({
  title,
  previous,
  updated,
  timeZone,
  onConfirm,
  onCancel,
}: MoveConfirmDialogProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  // 開いたら即座にカードへフォーカスし、Enter/Esc がすぐ効くようにする
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      onConfirm();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div
      className="move-confirm-backdrop"
      onPointerDown={(e) => {
        // バックドロップ自身(カードの外側)をクリックしたときだけキャンセル扱いにする
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={cardRef}
        className="move-confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-label="予定の移動確認"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <p className="move-confirm-title">「{title}」を移動しますか?</p>
        <p className="move-confirm-range">
          <span className="move-confirm-from">
            {formatDetailDateTime(previous.startMs, previous.endMs, timeZone)}
          </span>
          <span className="move-confirm-arrow" aria-hidden="true">
            →
          </span>
          <span className="move-confirm-to">
            {formatDetailDateTime(updated.startMs, updated.endMs, timeZone)}
          </span>
        </p>
        <div className="move-confirm-actions">
          <button type="button" className="move-confirm-confirm-btn" onClick={onConfirm}>
            移動する
          </button>
          <button type="button" className="move-confirm-cancel-btn" onClick={onCancel}>
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}
