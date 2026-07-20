import { useRef } from "react";
import type { PlannedBlock, TimeEntry } from "../model/types";
import { aggregatePlannedVsActual, formatDurationHm } from "../sync/timeTracking";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import "./TimeReportOverlay.css";

export interface TimeReportOverlayProps {
  plannedBlocks: PlannedBlock[];
  timeEntries: TimeEntry[];
  /** 走行中エントリの経過を含めて集計するための現在時刻 */
  nowMs: number;
  onClose: () => void;
}

/**
 * 予定 vs 実績レポート(docs/github-integration.md「時間計測」増分2、2026-07-20)。
 * BlockRulesOverlay/SearchOverlay と同じ画面中央モーダル構成。表示専用(編集導線は無い)なので
 * BlockRulesOverlay より単純 — sync/timeTracking.ts の aggregatePlannedVsActual をそのまま
 * 表にするだけ。commit からの実績自動推定(増分3)はまだ無いため、実績は手動タイマーのみ反映する。
 */
export function TimeReportOverlay({
  plannedBlocks,
  timeEntries,
  nowMs,
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
          ごとに、予定タイムブロックの合計と手動タイマーで記録した実績の合計を突き合わせます。commit
          からの自動推定はまだありません。
        </p>
        {rows.length === 0 ? (
          <p className="time-report-empty">まだ予定・実績がありません</p>
        ) : (
          <table className="time-report-table">
            <thead>
              <tr>
                <th className="time-report-col-item">アイテム</th>
                <th className="time-report-col-num">予定</th>
                <th className="time-report-col-num">実績</th>
                <th className="time-report-col-bar">比率</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const max = Math.max(row.plannedMs, row.actualMs, 1);
                const plannedPct = (row.plannedMs / max) * 100;
                const actualPct = (row.actualMs / max) * 100;
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
