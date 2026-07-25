import { useRef, useState } from "react";
import type { WorkLogDTO } from "@kichijitsu/shared";
import type { PlannedBlock, TimeEntry } from "../model/types";
import { buildReportRows, reportRowsToCsv } from "../sync/reportExport";
import { formatDurationHm } from "../sync/timeTracking";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import "./TimeReportOverlay.css";

const REPORT_CSV_FILENAME = "kichijitsu-report.csv";

export interface TimeReportOverlayProps {
  plannedBlocks: PlannedBlock[];
  timeEntries: TimeEntry[];
  /**
   * work_logs 実績。実績 UX 刷新(2026-07-23)で旧 GitHubPane 実績セクションの CSV エクスポートを
   * このレポートへ移した。buildReportRows で予定/実績(手動)/hook 実績/推定を1行にマージし、
   * 表と CSV の両方をこの生ログから組み立てる(2026-07-25) — 予定タイムブロックの無い実績
   * (手動記録や ▶→⏹ で確定した分)は work_logs にしか無いため、行の母集合をここから作らないと
   * 表が空・CSV ボタン disabled になってしまう。
   */
  workLogs: WorkLogDTO[];
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
   * @deprecated このコンポーネントでは使っていない(2026-07-25)。hook 実績は workLogs から
   * buildReportRows が行ごとに算出する(ActualsReportRow.hookActualMs)。呼び出し側 (App.tsx) が
   * 渡すこの Record は「予定タイムブロックの linkedItemId 集合」でしか突合しておらず、予定の無い
   * 実績(work_logs だけの item)の行では値が引けない — 行の母集合を「予定 ∪ work_logs」へ広げた
   * 意味が失われるため使わない。任意 prop として受け口だけ残してあるので、App.tsx 側の
   * reportHookActualByLinkedItem(現在ここ以外で使われていない)ごと消せる。
   */
  hookActualByLinkedItem?: Record<string, number>;
  onClose: () => void;
}

/**
 * 予定 vs 実績レポート(docs/github-integration.md「時間計測」増分2・3、mcp.md「エージェントの
 * 作業時間記録」、2026-07-20〜21)。BlockRulesOverlay/SearchOverlay と同じ画面中央モーダル構成。
 * 表示専用(編集導線は無い)。行(item)の母集合と3経路の突合は sync/reportExport.ts の
 * buildReportRows に一本化してあり、表と CSV は同じ行を使う — 予定タイムブロックの無い実績
 * (work_logs だけの item)も行として並ぶ(2026-07-25 修正)。
 * 列は3経路: 「計測中」は▶/⏹で現在走行中のタイマーの経過
 * (sync/timeTracking.ts の aggregatePlannedVsActual。実績 UX 刷新フェーズ4(2026-07-23)で
 * タイマー停止時の確定実績を work_logs へ統一したため、この列に残るのは走行中エントリの経過のみ)、
 * 「実績」は work_logs に保存された作業時間(sync/hookActual.ts。タイマーの停止・手動記録・
 * Claude Code 等の hook をまとめた値。issueRef が数値のときのみ突合できる正確な計測値)、
 * 「推定」は PR の commit から自動推定した値(sync/estimateActual.ts、あくまで見積もり)。
 * 3つとも別のデータとして扱い混同表示しない — 推定は "≈" プレフィックス+破線区切りで、
 * 実績も同じ破線区切りで(計測中の実線罫線とは対照的に)視覚的に区別する。
 * issue 行には commit が無い(対象外)ため推定列は常に「—」。
 */
export function TimeReportOverlay({
  plannedBlocks,
  timeEntries,
  workLogs,
  nowMs,
  estimatedByKey,
  estimatesLoading,
  onClose,
}: TimeReportOverlayProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  useCloseOnOutsideOrEscape(true, cardRef, onClose);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  // 表と CSV は同じ行(reportExport.ts の buildReportRows)を使う。行の母集合は
  // 「予定タイムブロック ∪ 走行中タイマー ∪ work_logs」なので、予定を立てずに実績だけ記録した
  // item もここに現れる(hook 実績・推定のマージも純関数側で済んでいる)。
  const rows = buildReportRows(
    { plannedBlocks, timeEntries, workLogs, estimatesByKey: estimatedByKey },
    nowMs,
  );

  function handleDownloadCsv() {
    const csv = reportRowsToCsv(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = REPORT_CSV_FILENAME;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleCopyCsv() {
    const csv = reportRowsToCsv(rows);
    try {
      await navigator.clipboard.writeText(csv);
      setCopyState("copied");
    } catch (err) {
      console.warn("kichijitsu: clipboard.writeText failed", err);
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 2000);
  }

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
          <div className="time-report-header-actions">
            <button
              type="button"
              className="time-report-csv-btn"
              onClick={handleDownloadCsv}
              disabled={rows.length === 0}
              title="予定・実績・推定を CSV(分単位)でダウンロードします"
            >
              CSV
            </button>
            <button
              type="button"
              className="time-report-csv-btn"
              onClick={handleCopyCsv}
              disabled={rows.length === 0}
              title="CSV をクリップボードにコピーします"
            >
              {copyState === "copied" ? "コピー済み" : copyState === "failed" ? "失敗" : "コピー"}
            </button>
            <button type="button" className="time-report-close" onClick={onClose} aria-label="閉じる">
              ×
            </button>
          </div>
        </div>
        <p className="time-report-description">
          issue / PR
          ごとに、予定タイムブロックの合計と実績を突き合わせます。「計測中」は▶/⏹で計測中のタイマーの経過
          (停止すると実績として保存されます)。「実績」は work_logs
          に保存された作業時間(タイマーの停止・手動記録・Claude Code 等の hook をまとめた値)。
          「推定」は PR の commit
          時刻から自動推定した値(あくまで見積もりで、実績とは別物です)。
        </p>
        {rows.length === 0 ? (
          <p className="time-report-empty">まだ予定・実績がありません</p>
        ) : (
          <table className="time-report-table">
            <thead>
              <tr>
                <th className="time-report-col-item">アイテム</th>
                <th className="time-report-col-num">予定</th>
                <th
                  className="time-report-col-num"
                  title="▶/⏹ で現在計測中のタイマーの経過時間です。停止すると work_logs に保存され「実績」列へ移ります。"
                >
                  計測中
                </th>
                <th
                  className="time-report-col-num time-report-col-hook"
                  title="work_logs に保存された作業時間です。タイマーの停止・手動記録・Claude Code 等の hook (log_work_interval) をまとめた値で、issue 番号が数値のときのみ item に突き合わせられます(番号の無い記録・ブランチ名だけの記録はこの表に並びません)。"
                >
                  実績
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
                // 比率バーの「実績」は 計測中(走行中の経過)+ 実績(work_logs) の合計で描く —
                // 確定した実績は work_logs 側にしか無いため、actualMs だけで描くと予定を立てずに
                // 記録した行のバーが常に空になり比率が読めない。
                const actualTotalMs = row.actualMs + (row.hookActualMs ?? 0);
                const max = Math.max(row.plannedMs, actualTotalMs, 1);
                const plannedPct = (row.plannedMs / max) * 100;
                const actualPct = (actualTotalMs / max) * 100;
                const estimatedMs = row.estimateMs;
                const hookMs = row.hookActualMs;
                return (
                  <tr key={row.linkedItemId}>
                    <td className="time-report-item">
                      <a
                        className="time-report-item-link"
                        href={row.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {/* work_logs 由来の行はタイトルを持たない(空文字)ので `#番号` だけ出す */}
                        #{row.number}
                        {row.title ? ` ${row.title}` : ""}
                      </a>
                      <span className="time-report-item-repo">{row.repo}</span>
                    </td>
                    <td className="time-report-col-num">{formatDurationHm(row.plannedMs)}</td>
                    <td className="time-report-col-num">{formatDurationHm(row.actualMs)}</td>
                    <td
                      className="time-report-col-num time-report-col-hook"
                      title="work_logs に保存された実績(タイマーの停止・手動記録・hook をまとめた値)"
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
