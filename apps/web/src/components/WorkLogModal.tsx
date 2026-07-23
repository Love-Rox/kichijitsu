import { useMemo, useRef, useState } from "react";
import type {
  GitHubWorkItemDTO,
  WorkLogCreateRequest,
  WorkLogDTO,
  WorkLogUpdateRequest,
} from "@kichijitsu/shared";
import type { PlannedBlock, TimeEntry } from "../model/types";
import { entryDurationMs, formatDurationHm, type TimerLinkedItem } from "../sync/timeTracking";
import {
  buildWorkLogCreateRequest,
  buildWorkLogUpdateRequest,
  collectWorkLogOrgCandidates,
  collectWorkLogRepoCandidates,
  combineOrgRepo,
  isManualWorkLog,
  validateWorkLogEntryForm,
  workLogToFormInput,
  WORK_LOG_ENTRY_ERROR_MESSAGES,
  type WorkLogEntryFormInput,
} from "../sync/workLogEntry";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import "./WorkLogModal.css";

export interface WorkLogModalProps {
  workLogs: WorkLogDTO[];
  plannedBlocks: PlannedBlock[];
  /** 未完了の作業キュー(issue/PR)。タイマー節で ▶/⏹ を出す元データ(GitHubPane と同じ一覧) */
  githubQueue: GitHubWorkItemDTO[];
  /** 走行中判定・経過表示用の全 TimeEntry(endMs===null が走行中)。GitHubPane 側の ▶/⏹ と共有 */
  timeEntries: TimeEntry[];
  /** 経過時間表示に使う現在時刻(App.tsx の timerNowMs、走行中があるとき1秒 tick で更新) */
  nowMs: number;
  /** ▶ から呼ばれる。走行中エントリ(ローカル)を作る(App.onStartTimer) */
  onStartTimer: (item: TimerLinkedItem) => void;
  /** ⏹ から呼ばれる。対象を停止して work_logs へ保存する(App.onStopTimer) */
  onStopTimer: (linkedItemId: string) => void;
  /** datetime-local の入力/表示をアプリ設定のタイムゾーンのローカル壁時計として解釈するために使う */
  timeZone: string;
  /** 実績を手動で追加する。成功後は App.tsx が work-logs を再取得して反映する(非楽観更新) */
  onCreate: (req: WorkLogCreateRequest) => Promise<void>;
  /** 既存の実績を部分更新する(PATCH /api/work-logs/:id)。成功後は App.tsx が再取得する */
  onUpdate: (id: string, req: WorkLogUpdateRequest) => Promise<void>;
  /** 実績を削除する(DELETE /api/work-logs/:id)。成功後は App.tsx が再取得する */
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}

/**
 * 実績(work-log)専用モーダル(実績 UX 刷新フェーズ2、2026-07-23)。手動追加フォームと、過去記録の
 * 編集/削除を1箇所に集約する。旧 GitHubPane の ManualWorkLogSection(手動追加+直近一覧)と、旧
 * TimeReportOverlay の「実績ログ」一覧(全件+削除)が担っていた write 系導線をここへ寄せた
 * (GitHubPane はこのモーダルを開くボタンのみ、TimeReportOverlay は予定 vs 実績の閲覧に専念する)。
 *
 * モーダルの作法は SettingsModal / TimeReportOverlay と同じ: backdrop + 中央カード +
 * useCloseOnOutsideOrEscape(外側クリック・Escape で閉じる) + × 閉じるボタン + ブランドトークン。
 *
 * 上段: 手動追加フォーム(org/repo は既存の datalist サジェストを維持。combineOrgRepo →
 * validateWorkLogEntryForm → buildWorkLogCreateRequest → onCreate、成功で resetForm)。
 * 下段: 実績履歴(全件・startMs 降順)。各行に編集(インラインフォーム、現値プリフィル →
 * buildWorkLogUpdateRequest → onUpdate)と削除(行ごとの2段階確認)。hook 記録(isManualWorkLog
 * が false)も編集・削除できるが、agent 欄をそのまま見せて手動/hook を区別できるようにする。
 */
export function WorkLogModal({
  workLogs,
  plannedBlocks,
  githubQueue,
  timeEntries,
  nowMs,
  onStartTimer,
  onStopTimer,
  timeZone,
  onCreate,
  onUpdate,
  onDelete,
  onClose,
}: WorkLogModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  useCloseOnOutsideOrEscape(true, cardRef, onClose);

  const repoCandidates = useMemo(
    () => collectWorkLogRepoCandidates(workLogs, plannedBlocks),
    [workLogs, plannedBlocks],
  );
  const orgCandidates = useMemo(
    () => collectWorkLogOrgCandidates(workLogs, plannedBlocks),
    [workLogs, plannedBlocks],
  );
  const history = useMemo(
    () => [...workLogs].sort((a, b) => b.startMs - a.startMs),
    [workLogs],
  );
  // linkedItemId(= GitHubWorkItemDTO.id)→ 走行中エントリ。作業キュー各行の ▶/⏹ 切り替えと
  // 経過表示に使う。走行中(endMs===null)は同一 linkedItemId につき高々1件という不変条件
  // (timeEntryStore 側が担保)なので Map で1件持てば足りる。
  const runningByLinkedItem = useMemo(() => {
    const map = new Map<string, TimeEntry>();
    for (const e of timeEntries) {
      if (e.endMs === null) map.set(e.linkedItemId, e);
    }
    return map;
  }, [timeEntries]);

  return (
    <div className="work-log-modal-backdrop">
      <div
        className="work-log-modal-card"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label="実績の記録・編集"
      >
        <div className="work-log-modal-header">
          <span className="work-log-modal-title">実績の記録・編集</span>
          <button
            type="button"
            className="work-log-modal-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </div>

        <section className="work-log-modal-section">
          <h3 className="work-log-modal-section-title">未完了の issue/PR(タイマー)</h3>
          <p className="work-log-modal-section-desc">
            作業キューの issue/PR です。▶ で計測を開始し、⏹ で停止すると実績(work_log)として
            保存され、下の実績履歴に現れます(GitHubPane やヘッダーからも操作できます)。
          </p>
          {githubQueue.length === 0 ? (
            <p className="work-log-modal-empty">未完了の issue/PR はありません</p>
          ) : (
            <ul className="work-log-modal-timer-list">
              {githubQueue.map((item) => (
                <TimerQueueRow
                  key={item.id}
                  item={item}
                  running={runningByLinkedItem.get(item.id) ?? null}
                  nowMs={nowMs}
                  onStartTimer={onStartTimer}
                  onStopTimer={onStopTimer}
                />
              ))}
            </ul>
          )}
        </section>

        <section className="work-log-modal-section">
          <h3 className="work-log-modal-section-title">実績を手動で記録</h3>
          <ManualWorkLogForm
            orgCandidates={orgCandidates}
            repoCandidates={repoCandidates}
            timeZone={timeZone}
            onCreate={onCreate}
          />
        </section>

        <section className="work-log-modal-section">
          <h3 className="work-log-modal-section-title">実績履歴</h3>
          <p className="work-log-modal-section-desc">
            手動で記録した実績と、hook(Claude Code 等)が自動記録した実績の全件です(新しい順)。
            どちらも編集・削除できます — agent 欄で手動(manual)/hook の記録を見分けられます。
          </p>
          {history.length === 0 ? (
            <p className="work-log-modal-empty">まだ実績がありません</p>
          ) : (
            <ul className="work-log-modal-history-list">
              {history.map((log) => (
                <WorkLogHistoryRow
                  key={log.id}
                  log={log}
                  timeZone={timeZone}
                  onUpdate={onUpdate}
                  onDelete={onDelete}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

interface TimerQueueRowProps {
  item: GitHubWorkItemDTO;
  /** 走行中エントリ(この item を計測中)。null なら停止中で ▶ を出す */
  running: TimeEntry | null;
  nowMs: number;
  onStartTimer: (item: TimerLinkedItem) => void;
  onStopTimer: (linkedItemId: string) => void;
}

/**
 * 作業キュー1行のタイマー操作(実績 UX 刷新フェーズ4、2026-07-23)。GitHubPane / WeekGrid の
 * ▶/⏹ と同じ App.onStartTimer/onStopTimer を叩くだけの薄い行 — 走行中判定・経過表示は
 * RunningTimersIndicator と同じ entryDurationMs / formatDurationHm を再利用する。
 * GitHubWorkItemDTO(shared)は TimerLinkedItem を構造的に満たす(id→linkedItemId、type→itemType)
 * ので、▶ 押下時にその形へ詰め替えて渡す(planned.ts の buildPlannedBlock と同じ対応関係)。
 */
function TimerQueueRow({ item, running, nowMs, onStartTimer, onStopTimer }: TimerQueueRowProps) {
  return (
    <li className="work-log-modal-timer-item">
      <a
        className={`work-log-modal-timer-link work-log-modal-timer-link--${item.type}`}
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`${item.repo} #${item.number} ${item.title}`}
      >
        <span className="work-log-modal-timer-kind" aria-hidden="true">
          {item.type === "pr" ? "PR" : "Iss"}
        </span>
        <span className="work-log-modal-timer-main">
          <span className="work-log-modal-timer-title">{item.title}</span>
          <span className="work-log-modal-timer-meta">
            {item.repo} #{item.number}
          </span>
        </span>
      </a>
      {running ? (
        <>
          <span className="work-log-modal-timer-elapsed" aria-live="polite">
            計測中 {formatDurationHm(entryDurationMs(running, nowMs))}
          </span>
          <button
            type="button"
            className="work-log-modal-timer-btn work-log-modal-timer-btn--stop"
            onClick={() => onStopTimer(item.id)}
            aria-label={`${item.repo} #${item.number} のタイマーを停止`}
            title="停止して実績を保存"
          >
            ⏹
          </button>
        </>
      ) : (
        <button
          type="button"
          className="work-log-modal-timer-btn work-log-modal-timer-btn--start"
          onClick={() =>
            onStartTimer({
              linkedItemId: item.id,
              itemType: item.type,
              title: item.title,
              repo: item.repo,
              number: item.number,
              url: item.url,
            })
          }
          aria-label={`${item.repo} #${item.number} のタイマーを開始`}
          title="計測を開始"
        >
          ▶
        </button>
      )}
    </li>
  );
}

interface ManualWorkLogFormProps {
  orgCandidates: string[];
  repoCandidates: string[];
  timeZone: string;
  onCreate: (req: WorkLogCreateRequest) => Promise<void>;
}

/**
 * 手動追加フォーム(旧 GitHubPane ManualWorkLogSection のフォームをそのまま移植)。サーバーの
 * WorkLogCreateRequest は repo 1フィールドのみだが、UI では org / repo を別入力にしてサジェスト
 * (datalist)を効かせやすくし、送信時に combineOrgRepo で "org/repo" へ結合する(送信ボディの形は
 * 変えない、workLogEntry.ts のコメント参照)。org/repo の実データ化プルダウンは次フェーズ。
 */
function ManualWorkLogForm({
  orgCandidates,
  repoCandidates,
  timeZone,
  onCreate,
}: ManualWorkLogFormProps) {
  const [org, setOrg] = useState("");
  const [repo, setRepo] = useState("");
  const [issueRef, setIssueRef] = useState("");
  const [startLocal, setStartLocal] = useState("");
  const [endLocal, setEndLocal] = useState("");
  const [agent, setAgent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetForm() {
    setOrg("");
    setRepo("");
    setIssueRef("");
    setStartLocal("");
    setEndLocal("");
    setAgent("");
  }

  function handleSave() {
    const input: WorkLogEntryFormInput = {
      repo: combineOrgRepo(org, repo),
      issueRef,
      startLocal,
      endLocal,
      agent,
    };
    const validationError = validateWorkLogEntryForm(input, timeZone);
    if (validationError) {
      setError(WORK_LOG_ENTRY_ERROR_MESSAGES[validationError]);
      return;
    }
    setSubmitting(true);
    setError(null);
    onCreate(buildWorkLogCreateRequest(input, timeZone))
      .then(() => resetForm())
      .catch((err) => {
        console.error("kichijitsu: work log create failed", err);
        setError("追加に失敗しました。しばらくしてから試してください");
      })
      .finally(() => setSubmitting(false));
  }

  return (
    <div className="work-log-modal-form">
      <div className="work-log-modal-field-row">
        <div className="work-log-modal-field">
          <span className="work-log-modal-label">org</span>
          <input
            type="text"
            className="work-log-modal-input"
            list="work-log-modal-org-candidates"
            placeholder="owner"
            value={org}
            disabled={submitting}
            onChange={(e) => setOrg(e.target.value)}
          />
          <datalist id="work-log-modal-org-candidates">
            {orgCandidates.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </div>
        <div className="work-log-modal-field">
          <span className="work-log-modal-label">repo</span>
          <input
            type="text"
            className="work-log-modal-input"
            list="work-log-modal-repo-candidates"
            placeholder="repo"
            value={repo}
            disabled={submitting}
            onChange={(e) => setRepo(e.target.value)}
          />
          <datalist id="work-log-modal-repo-candidates">
            {repoCandidates.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </div>
      </div>

      <div className="work-log-modal-field">
        <span className="work-log-modal-label">issue/PR番号(任意)</span>
        <input
          type="text"
          className="work-log-modal-input"
          placeholder="42"
          value={issueRef}
          disabled={submitting}
          onChange={(e) => setIssueRef(e.target.value)}
        />
      </div>

      <div className="work-log-modal-field-row">
        <div className="work-log-modal-field">
          <span className="work-log-modal-label">開始</span>
          <input
            type="datetime-local"
            className="work-log-modal-input"
            value={startLocal}
            disabled={submitting}
            onChange={(e) => setStartLocal(e.target.value)}
          />
        </div>
        <div className="work-log-modal-field">
          <span className="work-log-modal-label">終了</span>
          <input
            type="datetime-local"
            className="work-log-modal-input"
            value={endLocal}
            disabled={submitting}
            onChange={(e) => setEndLocal(e.target.value)}
          />
        </div>
      </div>

      <div className="work-log-modal-field">
        <span className="work-log-modal-label">agent(任意、既定は manual)</span>
        <input
          type="text"
          className="work-log-modal-input"
          placeholder="manual"
          value={agent}
          disabled={submitting}
          onChange={(e) => setAgent(e.target.value)}
        />
      </div>

      <div className="work-log-modal-submit-row">
        <button
          type="button"
          className="work-log-modal-save-btn"
          disabled={submitting}
          onClick={handleSave}
        >
          {submitting ? "追加中…" : "実績を追加"}
        </button>
        {error && <span className="work-log-modal-error">{error}</span>}
      </div>
    </div>
  );
}

interface WorkLogHistoryRowProps {
  log: WorkLogDTO;
  timeZone: string;
  onUpdate: (id: string, req: WorkLogUpdateRequest) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

type RowMode =
  | { kind: "view" }
  | { kind: "confirm-delete" }
  | { kind: "deleting" }
  | { kind: "editing" };

/**
 * 実績履歴の1行。表示モードでは repo・issue・期間・agent を見せ、「編集」でインライン編集フォーム
 * (現値プリフィル)へ、「削除」で行ごとの2段階確認(SettingsModal の AccountDisconnectControl と
 * 同じ流儀)へ切り替える。手動記録・hook 記録のどちらも編集/削除できる(agent バッジで区別)。
 * 編集の保存・削除は非楽観更新 — onUpdate/onDelete 成功後に App.tsx が work-logs を再取得する
 * (成功時は本行が新しいリストで置き換わるため、ここで view へ戻す必要は無い)。
 */
function WorkLogHistoryRow({ log, timeZone, onUpdate, onDelete }: WorkLogHistoryRowProps) {
  const [mode, setMode] = useState<RowMode>({ kind: "view" });
  const [deleteError, setDeleteError] = useState(false);
  const manual = isManualWorkLog(log);

  if (mode.kind === "editing") {
    return (
      <li className="work-log-modal-history-item work-log-modal-history-item--editing">
        <WorkLogEditForm
          log={log}
          timeZone={timeZone}
          onUpdate={onUpdate}
          onCancel={() => setMode({ kind: "view" })}
        />
      </li>
    );
  }

  return (
    <li className="work-log-modal-history-item">
      <span className="work-log-modal-history-main">
        <span className="work-log-modal-history-repo">{log.repo}</span>
        {log.issueRef && <span className="work-log-modal-history-issue">#{log.issueRef}</span>}
        <span
          className={
            manual
              ? "work-log-modal-history-badge work-log-modal-history-badge--manual"
              : "work-log-modal-history-badge"
          }
        >
          {log.agent ?? "(agent 不明)"}
        </span>
      </span>
      <span className="work-log-modal-history-time">
        {formatWorkLogRange(log.startMs, log.endMs)}(
        {formatDurationHm(Math.max(0, log.endMs - log.startMs))})
      </span>
      {mode.kind === "confirm-delete" || mode.kind === "deleting" ? (
        <span className="work-log-modal-confirm">
          削除しますか？
          <button
            type="button"
            className="work-log-modal-text-btn"
            disabled={mode.kind === "deleting"}
            onClick={() => {
              setMode({ kind: "deleting" });
              setDeleteError(false);
              onDelete(log.id).catch((err) => {
                console.error("kichijitsu: work log delete failed", err);
                setDeleteError(true);
                setMode({ kind: "view" });
              });
              // 成功時は App.tsx が work-logs を再取得して本行ごと消えるため view 復帰は不要
            }}
          >
            削除する
          </button>
          <button
            type="button"
            className="work-log-modal-text-btn"
            disabled={mode.kind === "deleting"}
            onClick={() => setMode({ kind: "view" })}
          >
            やめる
          </button>
        </span>
      ) : (
        <span className="work-log-modal-history-actions">
          <button
            type="button"
            className="work-log-modal-text-btn"
            onClick={() => setMode({ kind: "editing" })}
          >
            編集
          </button>
          <button
            type="button"
            className="work-log-modal-text-btn"
            onClick={() => setMode({ kind: "confirm-delete" })}
          >
            削除
          </button>
          {deleteError && <span className="work-log-modal-error">削除に失敗しました</span>}
        </span>
      )}
    </li>
  );
}

interface WorkLogEditFormProps {
  log: WorkLogDTO;
  timeZone: string;
  onUpdate: (id: string, req: WorkLogUpdateRequest) => Promise<void>;
  onCancel: () => void;
}

/**
 * インライン編集フォーム。現値を workLogToFormInput でプリフィルし、保存で buildWorkLogUpdateRequest
 * → onUpdate(id, req)。repo は編集フォームでは1欄のまま("org/repo" をそのまま出す、手動追加
 * フォームのような org/repo 分割はしない)。agent 欄も見せる — hook 記録を編集するとき、現値
 * (例: claude-code)をそのまま送り返せば維持される(buildWorkLogUpdateRequest のコメント参照)。
 */
function WorkLogEditForm({ log, timeZone, onUpdate, onCancel }: WorkLogEditFormProps) {
  const [form, setForm] = useState<WorkLogEntryFormInput>(() => workLogToFormInput(log, timeZone));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof WorkLogEntryFormInput>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleSave() {
    const validationError = validateWorkLogEntryForm(form, timeZone);
    if (validationError) {
      setError(WORK_LOG_ENTRY_ERROR_MESSAGES[validationError]);
      return;
    }
    setSubmitting(true);
    setError(null);
    onUpdate(log.id, buildWorkLogUpdateRequest(form, timeZone))
      .then(() => onCancel())
      .catch((err) => {
        console.error("kichijitsu: work log update failed", err);
        setError("更新に失敗しました。しばらくしてから試してください");
        setSubmitting(false);
      });
    // 成功時は App.tsx が再取得して本行が置き換わるが、置き換わるまでの一瞬のために onCancel で
    // view へ戻しておく(submitting の解除は成功パスでは不要、失敗時のみ上で解除)
  }

  return (
    <div className="work-log-modal-form">
      <div className="work-log-modal-field">
        <span className="work-log-modal-label">repo</span>
        <input
          type="text"
          className="work-log-modal-input"
          value={form.repo}
          disabled={submitting}
          onChange={(e) => set("repo", e.target.value)}
        />
      </div>

      <div className="work-log-modal-field">
        <span className="work-log-modal-label">issue/PR番号(任意)</span>
        <input
          type="text"
          className="work-log-modal-input"
          placeholder="42"
          value={form.issueRef}
          disabled={submitting}
          onChange={(e) => set("issueRef", e.target.value)}
        />
      </div>

      <div className="work-log-modal-field-row">
        <div className="work-log-modal-field">
          <span className="work-log-modal-label">開始</span>
          <input
            type="datetime-local"
            className="work-log-modal-input"
            value={form.startLocal}
            disabled={submitting}
            onChange={(e) => set("startLocal", e.target.value)}
          />
        </div>
        <div className="work-log-modal-field">
          <span className="work-log-modal-label">終了</span>
          <input
            type="datetime-local"
            className="work-log-modal-input"
            value={form.endLocal}
            disabled={submitting}
            onChange={(e) => set("endLocal", e.target.value)}
          />
        </div>
      </div>

      <div className="work-log-modal-field">
        <span className="work-log-modal-label">agent</span>
        <input
          type="text"
          className="work-log-modal-input"
          placeholder="manual"
          value={form.agent}
          disabled={submitting}
          onChange={(e) => set("agent", e.target.value)}
        />
      </div>

      <div className="work-log-modal-submit-row">
        <button
          type="button"
          className="work-log-modal-save-btn"
          disabled={submitting}
          onClick={handleSave}
        >
          {submitting ? "保存中…" : "保存"}
        </button>
        <button
          type="button"
          className="work-log-modal-text-btn"
          disabled={submitting}
          onClick={onCancel}
        >
          キャンセル
        </button>
        {error && <span className="work-log-modal-error">{error}</span>}
      </div>
    </div>
  );
}

/** epoch ms のペアを "M/D H:mm–H:mm" 形式で表示する(TimeReportOverlay/GitHubPane と同じ簡易フォーマット、
 * ブラウザのロケール依存を避ける。実績は大半が同日内という想定で終了側の日付は省略する)。 */
function formatWorkLogRange(startMs: number, endMs: number): string {
  const start = new Date(startMs);
  const end = new Date(endMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  const datePart = `${start.getMonth() + 1}/${start.getDate()}`;
  const startTime = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
  const endTime = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
  return `${datePart} ${startTime}–${endTime}`;
}
