import { useRef, useState } from "react";
import type { WorkLogCreateRequest, WorkLogDTO } from "@kichijitsu/shared";
import type { PlannedBlock, TimeEntry } from "../model/types";
import { reportItemKey } from "../sync/estimateActual";
import { aggregatePlannedVsActual, formatDurationHm } from "../sync/timeTracking";
import {
  buildWorkLogCreateRequest,
  collectWorkLogRepoCandidates,
  isManualWorkLog,
  validateWorkLogEntryForm,
  WORK_LOG_ENTRY_ERROR_MESSAGES,
  type WorkLogEntryFormInput,
} from "../sync/workLogEntry";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import "./TimeReportOverlay.css";

export interface TimeReportOverlayProps {
  plannedBlocks: PlannedBlock[];
  timeEntries: TimeEntry[];
  /** 走行中エントリの経過を含めて集計するための現在時刻 */
  nowMs: number;
  /** datetime-local の入力/表示に使うアプリ設定のタイムゾーン(EventEditForm と同じ) */
  timeZone: string;
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
  /**
   * GET /api/work-logs の生データ(集計前)。上の hookActualByLinkedItem は linkedItemId 単位に
   * 潰した集計値だが、こちらは1行=1記録の生ログ — 「実績ログ」セクション(手動追加フォーム・
   * 手動エントリの削除)が使う。App.tsx が保持する state をそのまま渡す。
   */
  workLogs: WorkLogDTO[];
  /** 実績を手動で追加する。成功/失敗は呼び出し側(App.tsx)が work-logs を再取得して反映する */
  onCreateWorkLog: (req: WorkLogCreateRequest) => Promise<void>;
  /** 手動エントリを削除する(訂正用)。hook 記録も id さえ分かれば削除できてしまうが、UI 上は
   * isManualWorkLog な行にしか削除ボタンを出さない(誤って hook 記録を消させないため) */
  onDeleteWorkLog: (id: string) => Promise<void>;
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
  timeZone,
  estimatedByKey,
  estimatesLoading,
  hookActualByLinkedItem,
  workLogs,
  onCreateWorkLog,
  onDeleteWorkLog,
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

        <section className="time-report-section">
          <h3 className="time-report-section-title">実績ログ</h3>
          <p className="time-report-section-description">
            hook が自動記録した実績と、手動で追加した実績の生ログです。手動で追加した行(agent:
            manual)だけ削除できます — hook
            記録を誤って消さないよう、削除ボタンは手動行にしか出しません。
          </p>
          <WorkLogList workLogs={workLogs} onDelete={onDeleteWorkLog} />
        </section>

        <section className="time-report-section">
          <h3 className="time-report-section-title">実績を手動で追加</h3>
          <ManualWorkLogForm
            plannedBlocks={plannedBlocks}
            workLogs={workLogs}
            timeZone={timeZone}
            onCreate={onCreateWorkLog}
          />
        </section>
      </div>
    </div>
  );
}

interface WorkLogListProps {
  workLogs: WorkLogDTO[];
  onDelete: (id: string) => Promise<void>;
}

/**
 * 実績ログの生一覧(startMs 降順)。App.tsx が保持する reportWorkLogs は GET /api/work-logs の
 * 上限 (新しい順500件、core/work-log.ts の listWorkLogsForProfile 参照) をそのまま引き継ぐため、
 * モーダル内で縦スクロールさせる(CSS の max-height、他フィールドは絞り込まない)。
 */
function WorkLogList({ workLogs, onDelete }: WorkLogListProps) {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);

  if (workLogs.length === 0) {
    return <p className="time-report-empty">まだ実績ログがありません</p>;
  }

  const sorted = [...workLogs].sort((a, b) => b.startMs - a.startMs);

  return (
    <ul className="time-report-worklog-list">
      {sorted.map((log) => {
        const manual = isManualWorkLog(log);
        return (
          <li className="time-report-worklog-item" key={log.id}>
            <span className="time-report-worklog-main">
              <span className="time-report-worklog-repo">{log.repo}</span>
              {log.issueRef && <span className="time-report-worklog-issue">#{log.issueRef}</span>}
              <span
                className={
                  manual
                    ? "time-report-worklog-badge time-report-worklog-badge--manual"
                    : "time-report-worklog-badge"
                }
              >
                {log.agent ?? "(agent 不明)"}
              </span>
            </span>
            <span className="time-report-worklog-time">
              {formatWorkLogRange(log.startMs, log.endMs)}(
              {formatDurationHm(Math.max(0, log.endMs - log.startMs))})
            </span>
            {manual && (
              <button
                type="button"
                className="time-report-worklog-delete"
                aria-label={`${log.repo} の実績ログを削除`}
                disabled={deletingId === log.id}
                onClick={() => {
                  setDeletingId(log.id);
                  setErrorId(null);
                  onDelete(log.id)
                    .catch((err) => {
                      console.error("kichijitsu: work log delete failed", err);
                      setErrorId(log.id);
                    })
                    .finally(() => setDeletingId(null));
                }}
              >
                ×
              </button>
            )}
            {errorId === log.id && <span className="time-report-error">削除に失敗しました</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** epoch ms のペアを "M/D H:mm–H:mm" 形式で表示する(ブラウザのロケール依存を避けた簡易フォーマット、
 * 秒は表示しない)。日をまたぐ場合も終了側の日付は省略する(実績ログは大半が同日内という想定、
 * 厳密な日またぎ表示が必要なら別途拡張する) */
function formatWorkLogRange(startMs: number, endMs: number): string {
  const start = new Date(startMs);
  const end = new Date(endMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  const datePart = `${start.getMonth() + 1}/${start.getDate()}`;
  const startTime = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
  const endTime = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
  return `${datePart} ${startTime}–${endTime}`;
}

interface ManualWorkLogFormProps {
  plannedBlocks: PlannedBlock[];
  workLogs: WorkLogDTO[];
  timeZone: string;
  onCreate: (req: WorkLogCreateRequest) => Promise<void>;
}

const EMPTY_FORM: WorkLogEntryFormInput = {
  repo: "",
  issueRef: "",
  startLocal: "",
  endLocal: "",
  agent: "",
};

/**
 * 実績の手動追加フォーム(BlockRulesOverlay の NewRuleForm と同じ役割分担: 入力 state・検証・
 * 送信中/エラー表示はこのコンポーネントが持ち、実際の POST と一覧の再取得は onCreate 経由で
 * 呼び出し元 (App.tsx の handleCreateWorkLog) に委ねる)。
 */
function ManualWorkLogForm({
  plannedBlocks,
  workLogs,
  timeZone,
  onCreate,
}: ManualWorkLogFormProps) {
  const [form, setForm] = useState<WorkLogEntryFormInput>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repoCandidates = collectWorkLogRepoCandidates(workLogs, plannedBlocks);

  function handleSave() {
    const validationError = validateWorkLogEntryForm(form, timeZone);
    if (validationError) {
      setError(WORK_LOG_ENTRY_ERROR_MESSAGES[validationError]);
      return;
    }
    setSubmitting(true);
    setError(null);
    onCreate(buildWorkLogCreateRequest(form, timeZone))
      .then(() => setForm(EMPTY_FORM))
      .catch((err) => {
        console.error("kichijitsu: work log create failed", err);
        setError("追加に失敗しました。しばらくしてから試してください");
      })
      .finally(() => setSubmitting(false));
  }

  return (
    <div className="time-report-form">
      <div className="time-report-field">
        <span className="time-report-field-label">repo</span>
        <input
          type="text"
          className="time-report-input"
          list="time-report-repo-candidates"
          placeholder="owner/repo"
          value={form.repo}
          disabled={submitting}
          onChange={(e) => setForm({ ...form, repo: e.target.value })}
        />
        <datalist id="time-report-repo-candidates">
          {repoCandidates.map((repo) => (
            <option key={repo} value={repo} />
          ))}
        </datalist>
      </div>

      <div className="time-report-field">
        <span className="time-report-field-label">issue/PR番号(任意)</span>
        <input
          type="text"
          className="time-report-input"
          placeholder="42"
          value={form.issueRef}
          disabled={submitting}
          onChange={(e) => setForm({ ...form, issueRef: e.target.value })}
        />
      </div>

      <div className="time-report-field-row">
        <div className="time-report-field">
          <span className="time-report-field-label">開始</span>
          <input
            type="datetime-local"
            className="time-report-input"
            value={form.startLocal}
            disabled={submitting}
            onChange={(e) => setForm({ ...form, startLocal: e.target.value })}
          />
        </div>
        <div className="time-report-field">
          <span className="time-report-field-label">終了</span>
          <input
            type="datetime-local"
            className="time-report-input"
            value={form.endLocal}
            disabled={submitting}
            onChange={(e) => setForm({ ...form, endLocal: e.target.value })}
          />
        </div>
      </div>

      <div className="time-report-field">
        <span className="time-report-field-label">agent(任意、既定は manual)</span>
        <input
          type="text"
          className="time-report-input"
          placeholder="manual"
          value={form.agent}
          disabled={submitting}
          onChange={(e) => setForm({ ...form, agent: e.target.value })}
        />
      </div>

      <div className="time-report-submit-row">
        <button
          type="button"
          className="time-report-save-btn"
          disabled={submitting}
          onClick={handleSave}
        >
          {submitting ? "追加中…" : "実績を追加"}
        </button>
        {error && <span className="time-report-error">{error}</span>}
      </div>
    </div>
  );
}
