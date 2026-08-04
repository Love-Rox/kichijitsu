import { useMemo, useRef, useState } from "react";
import type { BlockMirrorCleanupItem, BlockMirrorScanEntry, OrphanMirrorDTO } from "@kichijitsu/shared";
import {
  describeCleanupTargets,
  formatOrphanRange,
  groupOrphansByCalendar,
  orphanKey,
  resolveSelectedOrphans,
  scanFailures,
  type BlockMirrorFailedDetail,
} from "../sync/blockMirrorCleanup";
import type { BlockMirrorScanState } from "../hooks/useBlockMirrorCleanup";
import { addToSet, removeFromSet } from "../layout/setOps";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import "./BlockMirrorCleanupOverlay.css";

export interface BlockMirrorCleanupOverlayProps {
  scanState: BlockMirrorScanState;
  scanned: BlockMirrorScanEntry[];
  orphans: OrphanMirrorDTO[];
  lastFailures: BlockMirrorFailedDetail[];
  onScan: () => Promise<void>;
  /** 失敗時は throw する(fetch 自体の失敗。個々の予定の失敗は lastFailures 経由で戻る) */
  onCleanup: (items: BlockMirrorCleanupItem[]) => Promise<void>;
  onClose: () => void;
}

/**
 * 「コピー先に残ったブロック予定の掃除」オーバーレイ (docs/blocking.md「将来やるならこれ」)。
 * ルール削除・target 変更・連携解除のどれで出た孤児かを区別せず、target カレンダーを
 * 直接走査して見つけ、選んだものだけを消す ―― BlockRulesOverlay とは独立した導線
 * (ルール一覧を経由しない)。BlockRulesOverlay.tsx と同じ画面中央モーダル構成・
 * useCloseOnOutsideOrEscape での開閉に揃えている。
 *
 * **既定では何も選択されていない**(state は毎回このコンポーネントのマウントから始まる ――
 * App 側は `{open && <Overlay/>}` で開閉するため、閉じて開き直すたびに選択もリセットされる)。
 * Google 上の予定を実際に削除する操作なので、選ぶのも消すのも常に利用者の明示操作を経由させる。
 */
export function BlockMirrorCleanupOverlay({
  scanState,
  scanned,
  orphans,
  lastFailures,
  onScan,
  onCleanup,
  onClose,
}: BlockMirrorCleanupOverlayProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  useCloseOnOutsideOrEscape(true, cardRef, onClose);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [deleteState, setDeleteState] = useState<"idle" | "confirming" | "deleting" | "error">(
    "idle",
  );

  const groups = useMemo(() => groupOrphansByCalendar(orphans, scanned), [orphans, scanned]);
  const failures = useMemo(() => scanFailures(scanned), [scanned]);
  const selectedOrphans = useMemo(
    () => resolveSelectedOrphans(orphans, selected),
    [orphans, selected],
  );
  const confirmSummary = useMemo(
    () => describeCleanupTargets(selectedOrphans, scanned),
    [selectedOrphans, scanned],
  );

  const allSelected = orphans.length > 0 && selected.size === orphans.length;

  function toggleOne(key: string) {
    setSelected((prev) => (prev.has(key) ? removeFromSet(prev, key) : addToSet(prev, key)));
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(orphans.map((o) => orphanKey(o))));
  }

  function handleConfirmedDelete() {
    setDeleteState("deleting");
    onCleanup(selectedOrphans.map(toSelectionItem))
      .then(() => {
        // 成功後は選択を空に戻す(既定=未選択の原則を、実行後にも保つ)。まだ残っている
        // 行(失敗分・再走査していない分)は lastFailures 側の一覧で理由付きに見える
        setSelected(new Set());
        setDeleteState("idle");
      })
      .catch((err: unknown) => {
        console.error("kichijitsu: block mirror cleanup failed", err);
        setDeleteState("error");
      });
  }

  return (
    <div className="block-mirror-cleanup-backdrop">
      <div
        className="block-mirror-cleanup-card"
        ref={cardRef}
        role="dialog"
        aria-label="残ったブロック予定の掃除"
      >
        <div className="block-mirror-cleanup-header">
          <span className="block-mirror-cleanup-title">残ったブロック予定の掃除</span>
          <button
            type="button"
            className="block-mirror-cleanup-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </div>

        <p className="block-mirror-cleanup-description">
          コピー先カレンダーに作った「予定あり」を、全カレンダーを調べて探します。ルールを削除・
          変更したり連携を解除したりした後に残ったものも、まとめて見つかります。時間がかかることが
          あります。
        </p>

        <div className="block-mirror-cleanup-scan-row">
          <button
            type="button"
            className="block-mirror-cleanup-scan-btn"
            disabled={scanState === "scanning"}
            onClick={() => {
              void onScan();
            }}
          >
            {scanState === "scanning"
              ? "探しています…"
              : scanState === "done"
                ? "もう一度探す"
                : "残ったブロック予定を探す"}
          </button>
          {scanState === "scanning" && (
            <span className="block-mirror-cleanup-scanning" aria-live="polite">
              全カレンダーを調べています。しばらくお待ちください…
            </span>
          )}
          {scanState === "error" && (
            <span className="block-mirror-cleanup-error" role="alert">
              取得に失敗しました。もう一度お試しください
            </span>
          )}
        </div>

        {scanState === "done" && (
          <div className="block-mirror-cleanup-results">
            {failures.length > 0 && (
              <div className="block-mirror-cleanup-scan-failures" role="alert">
                <p className="block-mirror-cleanup-scan-failures-title">
                  次のカレンダーは調べられませんでした(見つかった件数にこのカレンダーの分は含まれません):
                </p>
                <ul>
                  {failures.map((f) => (
                    <li key={`${f.accountId}:${f.calendarId}`}>
                      {f.calendarSummary}
                      {f.error ? `(${f.error})` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="block-mirror-cleanup-summary">
              {scanned.length}件のカレンダーを調べ、{orphans.length}件の残ったブロック予定が見つかりました。
            </p>

            {orphans.length === 0 ? (
              <p className="block-mirror-cleanup-empty">残ったブロック予定は見つかりませんでした</p>
            ) : (
              <>
                <div className="block-mirror-cleanup-select-row">
                  <button type="button" className="block-mirror-cleanup-text-btn" onClick={toggleAll}>
                    {allSelected ? "選択を解除" : "すべて選択"}
                  </button>
                  <span className="block-mirror-cleanup-select-count">
                    {selected.size} / {orphans.length}件選択中
                  </span>
                </div>

                <ul className="block-mirror-cleanup-groups">
                  {groups.map((group) => (
                    <li key={group.key} className="block-mirror-cleanup-group">
                      <div className="block-mirror-cleanup-group-header">
                        <span className="block-mirror-cleanup-group-name">
                          {group.calendarSummary}
                        </span>
                        <span className="block-mirror-cleanup-group-count">
                          {group.orphans.length}件
                        </span>
                      </div>
                      <ul className="block-mirror-cleanup-items">
                        {group.orphans.map((o) => {
                          const key = orphanKey(o);
                          const checkboxId = `block-mirror-cleanup-item-${key}`;
                          return (
                            <li key={key} className="block-mirror-cleanup-item">
                              <label htmlFor={checkboxId} className="block-mirror-cleanup-item-label">
                                <input
                                  id={checkboxId}
                                  type="checkbox"
                                  checked={selected.has(key)}
                                  onChange={() => toggleOne(key)}
                                />
                                {/* 無内容原則: 予定の内容はサーバーから返らないため、見出しは常に固定 */}
                                <span className="block-mirror-cleanup-item-title">予定あり</span>
                                <span className="block-mirror-cleanup-item-range">
                                  {formatOrphanRange(o)}
                                </span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  ))}
                </ul>

                <DeleteBar
                  deleteState={deleteState}
                  confirmSummary={confirmSummary}
                  onRequestConfirm={() => setDeleteState("confirming")}
                  onCancel={() => setDeleteState("idle")}
                  onConfirm={handleConfirmedDelete}
                />
              </>
            )}

            {lastFailures.length > 0 && (
              <div className="block-mirror-cleanup-failed" role="alert">
                <p className="block-mirror-cleanup-failed-title">削除できなかった予定があります:</p>
                <ul>
                  {lastFailures.map((f) => (
                    <li key={f.eventId}>
                      {f.calendarSummary}: {f.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function toSelectionItem(o: OrphanMirrorDTO): BlockMirrorCleanupItem {
  return { accountId: o.accountId, calendarId: o.calendarId, eventId: o.eventId };
}

interface DeleteBarProps {
  deleteState: "idle" | "confirming" | "deleting" | "error";
  confirmSummary: { count: number; calendarSummaries: string[] };
  onRequestConfirm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * 選択削除の実行導線。RuleDeleteControl (BlockRulesOverlay.tsx) と同じ
 * 「押す → インライン確認 → 実行」の2段階だが、確認文が動的(件数・対象カレンダー名が
 * 選択のたびに変わる)なので ConfirmActionControl (settings/) には畳めない
 * (あちらの適用範囲は「設定モーダルの中の固定文言」に限定している、そのファイル冒頭コメント参照)。
 */
function DeleteBar({
  deleteState,
  confirmSummary,
  onRequestConfirm,
  onCancel,
  onConfirm,
}: DeleteBarProps) {
  if (deleteState === "confirming" || deleteState === "deleting" || deleteState === "error") {
    return (
      <div className="block-mirror-cleanup-confirm">
        <p className="block-mirror-cleanup-confirm-question">
          {confirmSummary.count}件の予定を、{confirmSummary.calendarSummaries.join("、")}
          から削除します。Google カレンダーから完全に削除され、元に戻せません。よろしいですか？
        </p>
        <div className="block-mirror-cleanup-confirm-actions">
          <button
            type="button"
            className="block-mirror-cleanup-danger-btn"
            disabled={deleteState === "deleting"}
            onClick={onConfirm}
          >
            {deleteState === "deleting" ? "削除中…" : "削除する"}
          </button>
          <button
            type="button"
            className="block-mirror-cleanup-text-btn"
            disabled={deleteState === "deleting"}
            onClick={onCancel}
          >
            やめる
          </button>
        </div>
        {deleteState === "error" && (
          <span className="block-mirror-cleanup-error" role="alert">
            削除に失敗しました。もう一度お試しください
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="block-mirror-cleanup-delete-row">
      <button
        type="button"
        className="block-mirror-cleanup-danger-btn"
        disabled={confirmSummary.count === 0}
        onClick={onRequestConfirm}
      >
        選択した予定を削除
      </button>
    </div>
  );
}
