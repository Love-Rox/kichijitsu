import { useRef } from "react";
import type { PlannedBlock, TimeEntry } from "../model/types";
import { reportItemKey } from "../sync/estimateActual";
import { aggregatePlannedVsActual, formatDurationHm } from "../sync/timeTracking";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import "./TimeReportOverlay.css";

export interface TimeReportOverlayProps {
  plannedBlocks: PlannedBlock[];
  timeEntries: TimeEntry[];
  /** 走行中エントリの経過を含めて集計するための現在時刻 */
  nowMs: number;
  /**
   * commit からの推定実績(docs/github-integration.md「時間計測」増分3 Part B)。キーは
   * `${repo}#${number}` (sync/estimateActual.ts の reportItemKey、サーバーの commitsByItem と
   * 同じ形式)。PR 行のみ埋まる想定 — issue 行のキーは含まれていなくてよい(「—」表示になる)。
   * 未連携/取得前は空オブジェクトのままでよい。
   */
  estimatedByKey: Record<string, number>;
  /** POST /api/github/pr-commits の取得中かどうか。true の間は推定列に「…」を出す */
  estimatesLoading: boolean;
  /**
   * hook 実績 (docs/mcp.md「エージェントの作業時間記録」、log_work_interval が「kichijitsu 実績」
   * カレンダーに書くイベント)。キーは PlannedBlock.linkedItemId、値は sync/hookActual.ts の
   * hookActualByLinkedItem が repo+number で突き合わせて合計した ms。手動タイマー実績・commit
   * からの推定とは別ソースの3つ目の実績経路 — 混同しないよう別列で併記する。一致が無い item は
   * キー自体が無い(「—」表示になる)。
   */
  hookActualByLinkedItem: Record<string, number>;
  onClose: () => void;
}

/**
 * 予定 vs 実績レポート(docs/github-integration.md「時間計測」増分2・3、mcp.md「エージェントの
 * 作業時間記録」、2026-07-20〜21)。BlockRulesOverlay/SearchOverlay と同じ画面中央モーダル構成。
 * 表示専用(編集導線は無い)。実績は3経路: 「実績(手動)」は手動タイマー
 * (sync/timeTracking.ts の aggregatePlannedVsActual、正確な計測値)、「実績(hook)」は Claude Code
 * 等の hook が自動記録した値(sync/hookActual.ts、issueRef が数値のときのみ突合できる正確な
 * 計測値)、「推定」は PR の commit から自動推定した値(sync/estimateActual.ts、あくまで見積もり)。
 * 3つとも別のデータとして扱い混同表示しない — 推定は "≈" プレフィックス+破線区切りで、
 * hook 実績も同じ破線区切りで(手動実績の実線罫線とは対照的に)視覚的に区別する。
 * issue 行には commit が無い(対象外)ため推定列は常に「—」。
 */
export function TimeReportOverlay({
  plannedBlocks,
  timeEntries,
  nowMs,
  estimatedByKey,
  estimatesLoading,
  hookActualByLinkedItem,
  onClose,
}: TimeReportOverlayProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  useCloseOnOutsideOrEscape(true, cardRef, onClose);

  const rows = aggregatePlannedVsActual(plannedBlocks, timeEntries, nowMs);

  return (
    <div className="time-report-backdrop">
      <div
        className="time-report-card"
        ref={cardRef}
        role="dialog"
        aria-label="予定 vs 実績レポート"
      >
        <div className="time-report-header">
          <span className="time-report-title">予定 vs 実績</span>
          <button type="button" className="time-report-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>
        <p className="time-report-description">
          issue / PR
          ごとに、予定タイムブロックの合計と実績を突き合わせます。「実績(手動)」は▶/⏹の手動タイマー、
          「実績(hook)」は Claude Code 等の hook が自動記録した作業時間(kichijitsu 実績カレンダー)。
          「推定」は PR の commit
          時刻から自動推定した値(あくまで見積もりで、いずれの実績とも別物です)。
        </p>
        {rows.length === 0 ? (
          <p className="time-report-empty">まだ予定・実績がありません</p>
        ) : (
          <table className="time-report-table">
            <thead>
              <tr>
                <th className="time-report-col-item">アイテム</th>
                <th className="time-report-col-num">予定</th>
                <th className="time-report-col-num">実績(手動)</th>
                <th
                  className="time-report-col-num time-report-col-hook"
                  title="Claude Code 等の hook (log_work_interval) が「kichijitsu 実績」カレンダーに自動記録した作業時間です。issueRef が数値のときのみ突き合わせられます。手動タイマーとは別の記録経路です。"
                >
                  実績(hook)
                </th>
                <th
                  className="time-report-col-num time-report-col-estimate"
                  title="PR の自分の commit 時刻から推定した値です(commit 間隔が90分を超えたら別セッションに分割、各セッションに commit 前の作業時間として30分のリードインを加算)。手動タイマーの実績とは別物のため参考値として扱ってください。"
                >
                  推定
                </th>
                <th className="time-report-col-bar">比率</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const max = Math.max(row.plannedMs, row.actualMs, 1);
                const plannedPct = (row.plannedMs / max) * 100;
                const actualPct = (row.actualMs / max) * 100;
                const estimatedMs =
                  row.itemType === "pr" ? estimatedByKey[reportItemKey(row)] : undefined;
                const hookMs = hookActualByLinkedItem[row.linkedItemId];
                return (
                  <tr key={row.linkedItemId}>
                    <td className="time-report-item">
                      <a
                        className="time-report-item-link"
                        href={row.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        #{row.number} {row.title}
                      </a>
                      <span className="time-report-item-repo">{row.repo}</span>
                    </td>
                    <td className="time-report-col-num">{formatDurationHm(row.plannedMs)}</td>
                    <td className="time-report-col-num">{formatDurationHm(row.actualMs)}</td>
                    <td
                      className="time-report-col-num time-report-col-hook"
                      title="hook (Claude Code 等の自動記録) からの実績"
                    >
                      {hookMs === undefined ? (
                        <span className="time-report-hook-empty">—</span>
                      ) : (
                        <span className="time-report-hook-value">{formatDurationHm(hookMs)}</span>
                      )}
                    </td>
                    <td
                      className="time-report-col-num time-report-col-estimate"
                      title="PR の commit 時刻からの推定値(参考値)"
                    >
                      {row.itemType !== "pr" ? (
                        <span className="time-report-estimate-empty">—</span>
                      ) : estimatedMs === undefined ? (
                        <span className="time-report-estimate-empty">
                          {estimatesLoading ? "…" : "—"}
                        </span>
                      ) : (
                        <span className="time-report-estimate-value">
                          ≈{formatDurationHm(estimatedMs)}
                        </span>
                      )}
                    </td>
                    <td className="time-report-col-bar">
                      <div className="time-report-bar-track" aria-hidden="true">
                        <span
                          className="time-report-bar time-report-bar--planned"
                          style={{ width: `${plannedPct}%` }}
                        />
                      </div>
                      <div className="time-report-bar-track" aria-hidden="true">
                        <span
                          className="time-report-bar time-report-bar--actual"
                          style={{ width: `${actualPct}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
