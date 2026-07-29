import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { formatDetailDateTime } from "../layout/gridMetrics";
import type { Occurrence } from "../model/types";
import { DEFAULT_RECURRENCE_SCOPE, type RecurrenceScope } from "../sync/recurrenceScope";
import "./MoveConfirmDialog.css";

export interface MoveConfirmDialogProps {
  title: string;
  timeZone: string;
  /**
   * 変更前後の時間帯。移動の確認 (purpose='move') でのみ渡す ―― 編集フォームの
   * 適用範囲の確認では、内容も一緒に変わっていて「時刻 → 時刻」の1行では表しきれない
   * ので出さない(フォーム側に入力内容がそのまま残っている)。
   */
  previous?: Occurrence;
  updated?: Occurrence;
  /**
   * 用途 (2026-07-30)。'move' (既定) = ドラッグ移動の確認、'edit' = 編集内容の適用範囲確認。
   * 見出しと確定ボタンの文言だけが変わる。
   */
  purpose?: "move" | "edit";
  /**
   * 繰り返し予定で選ばせる適用範囲 (2026-07-30、sync/recurrenceScope.ts)。
   * **空/未指定なら選択 UI を一切描かない** ―― 繰り返しでない予定は 2026-07-30 以前と
   * 完全に同じ見た目・同じキーボード操作のままになる。
   */
  scopes?: readonly RecurrenceScope[];
  onConfirm: (scope: RecurrenceScope) => void;
  onCancel: () => void;
}

const SCOPE_LABEL: Record<RecurrenceScope, string> = {
  this: "この予定のみ",
  all: "すべての予定",
};

/**
 * ドラッグ移動の確認ダイアログ(フェーズ2、2026-07-22)。WeekGrid 上でイベントを
 * ドラッグ移動 (kind==='move') すると楽観的に見た目だけ即座に動く(store.update 済み)が、
 * まだ IndexedDB/Google への書き込みは行っていない状態でこのダイアログを挟む。
 * 「移動する」で App.tsx の handlePersist(従来のドラッグ確定処理)を呼び、
 * 「キャンセル」で previous を store.update するだけで元の位置に戻せる
 * (sync/moveConfirm.ts のコメント参照)。
 *
 * 2026-07-30 の「繰り返し予定の適用範囲」で、**新しいダイアログを増やさずに**
 * 2つの役目を持たせた:
 *  1. 従来どおりのドラッグ移動の確認 (purpose='move')。
 *  2. 編集フォーム保存時の「どの予定に適用するか」の確認 (purpose='edit')。
 * 後者を別コンポーネントにしなかったのは、出す条件 (繰り返し予定を変更しようとしている)
 * も、聞くこと (適用範囲) も、押せる操作 (確定/キャンセル) も同じだからで、意匠を2つに
 * 分けると「移動のときだけ選択肢の並びが違う」といったズレを産む。
 *
 * BlockRulesOverlay.tsx と同じ画面中央のバックドロップ+カード構成。キーボード
 * Enter=確定/Esc=キャンセル(要件どおり)。適用範囲は <fieldset> + ラジオで、
 * 上下キーによる選択はブラウザ標準の挙動に任せる。
 */
export function MoveConfirmDialog({
  title,
  previous,
  updated,
  timeZone,
  purpose = "move",
  scopes,
  onConfirm,
  onCancel,
}: MoveConfirmDialogProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  // 既定は「この予定のみ」(Google カレンダーに合わせた、最も影響が小さい方)
  const [scope, setScope] = useState<RecurrenceScope>(DEFAULT_RECURRENCE_SCOPE);
  // 選択肢が2つ以上あるときだけラジオを出す。1つきりのときは「なぜ1つなのか」を
  // 文章で伝える(押せない選択肢を並べて見せるのは、選べるように見えて紛らわしい)
  const hasChoice = (scopes?.length ?? 0) > 1;
  const isRecurring = (scopes?.length ?? 0) > 0;

  // 開いたら即座にカードへフォーカスし、Enter/Esc がすぐ効くようにする
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      onConfirm(scope);
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
        aria-label={purpose === "edit" ? "予定の変更の適用範囲" : "予定の移動確認"}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <p className="move-confirm-title">
          {purpose === "edit" ? `「${title}」の変更を保存しますか?` : `「${title}」を移動しますか?`}
        </p>
        {previous && updated && (
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
        )}

        {hasChoice && (
          <fieldset className="move-confirm-scope">
            <legend className="move-confirm-scope-legend">適用範囲</legend>
            {scopes?.map((value) => (
              <label key={value} className="move-confirm-scope-option">
                <input
                  type="radio"
                  name="move-confirm-scope"
                  value={value}
                  checked={scope === value}
                  onChange={() => setScope(value)}
                />
                {SCOPE_LABEL[value]}
              </label>
            ))}
          </fieldset>
        )}
        {isRecurring && !hasChoice && (
          <p className="move-confirm-note">
            繰り返し予定のこの回だけに適用される。
            {purpose === "move"
              ? "日をまたぐ移動は繰り返しの曜日そのものが変わるため、シリーズ全体には適用できない。"
              : "開始日を別の日にする変更は繰り返しの曜日そのものが変わるため、シリーズ全体には適用できない。"}
            繰り返しの間隔や曜日を変えるときは Google カレンダー側で行う。
          </p>
        )}

        <div className="move-confirm-actions">
          <button
            type="button"
            className="move-confirm-confirm-btn"
            onClick={() => onConfirm(scope)}
          >
            {purpose === "edit" ? "保存する" : "移動する"}
          </button>
          <button type="button" className="move-confirm-cancel-btn" onClick={onCancel}>
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}
