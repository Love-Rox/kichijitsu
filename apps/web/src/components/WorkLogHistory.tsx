import { useEffect, useRef, useState } from "react";
import type { GitHubRepoIssue, WorkLogDTO, WorkLogUpdateRequest } from "@kichijitsu/shared";
import { formatDurationHm } from "../sync/timeTracking";
import {
  buildWorkLogUpdateRequest,
  isManualWorkLog,
  validateWorkLogEntryForm,
  workLogToFormInput,
  WORK_LOG_ENTRY_ERROR_MESSAGES,
  type WorkLogEntryFormInput,
} from "../sync/workLogEntry";
import { distinctIssueRepos, issueTitleKey, type WorkLogGroup } from "../sync/workLogGrouping";
import { formatWorkLogDateTime, formatWorkLogRange } from "../layout/gridMetrics";

/**
 * 実績履歴(グループ表示 → 行 → インライン編集フォーム)。2026-07-25 のファイル分割(リファクタ
 * フェーズ1b)で GitHubPane.tsx から切り出した ―― props の形・クラス名・挙動は無変更。
 * 日時表示だけは同時に修正しており、自前の new Date(...).getHours() 系フォーマッタをやめて
 * layout/gridMetrics.ts の formatWorkLogRange/formatWorkLogDateTime(timeZone を尊重)へ寄せた。
 * CSS(GitHubPane.css)の import は GitHubPane.tsx 側の1箇所のまま(PaneSection.tsx のコメント参照)。
 */
export interface WorkLogHistoryProps {
  groups: WorkLogGroup[];
  timeZone: string;
  onUpdate: (id: string, req: WorkLogUpdateRequest) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  fetchRepoIssues: (repo: string) => Promise<GitHubRepoIssue[]>;
}

/**
 * 実績履歴の本体(旧 WorkLogModal から移設、2026-07-25)。グループ見出しに出す issue/PR
 * タイトルのルックアップ(`repo#番号 → title`)をここで持つ ―― issue を持つグループの所属 repo を
 * 重複排除し、各 repo の open issue/PR 一覧を1回だけ取得して埋める。取得済み repo は
 * fetchedIssueReposRef で覚えて二重取得を避ける。fetchRepoIssues は open のみ返すため closed
 * issue のタイトルは引けない — その場合は従来の `repo #番号` のまま。取得失敗は握って warn のみ
 * (タイトルが出ないだけで履歴表示は止めない)。
 *
 * 実績履歴セクションは既定で折りたたみ、開いたときにこのコンポーネントがマウントされる ――
 * つまりタイトル補完の取得もユーザーが履歴を開いたときにしか走らない。
 */
export function WorkLogHistory({
  groups,
  timeZone,
  onUpdate,
  onDelete,
  fetchRepoIssues,
}: WorkLogHistoryProps) {
  const [issueTitles, setIssueTitles] = useState<Record<string, string>>({});
  const fetchedIssueReposRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const targets = distinctIssueRepos(groups).filter(
      (repo) => !fetchedIssueReposRef.current.has(repo),
    );
    if (targets.length === 0) return;
    for (const repo of targets) {
      // 走り出す前にマークして、同じ repo を二重に取りにいかないようにする。ただし
      // 「成功しなかった repo」はマークを外す ―― groups は workLogs 由来で毎回新しい配列に
      // なるため、実績の追加/削除やタイマー停止でこの effect が張り直る。以前は cleanup で
      // cancelled=true にして結果を捨てていたので、取得中に再実行が起きるとマークだけが残って
      // その repo のタイトルが永久に出なくなった(2026-07-25 のレビュー指摘)。
      // 解決した結果は破棄しない: setIssueTitles はマージ更新で、同じ repo を何度書いても
      // 冪等(アンマウント後の setState は React 19 では警告も無く無視される)なので捨てる理由が無い。
      fetchedIssueReposRef.current.add(repo);
      fetchRepoIssues(repo)
        .then((issues) => {
          setIssueTitles((prev) => {
            const next = { ...prev };
            for (const issue of issues) {
              next[issueTitleKey(repo, issue.number)] = issue.title;
            }
            return next;
          });
        })
        .catch((err) => {
          // 失敗はマークを外して次回の再実行(実績の増減や再オープン)で取り直せるようにする
          fetchedIssueReposRef.current.delete(repo);
          console.warn(
            `kichijitsu: 実績履歴の issue タイトル取得に失敗 (${repo}、タイトルは省略)`,
            err,
          );
        });
    }
  }, [groups, fetchRepoIssues]);

  if (groups.length === 0) {
    return <p className="github-pane-empty">まだ実績がありません</p>;
  }
  return (
    <ul className="github-pane-group-list">
      {groups.map((group, index) => (
        <WorkLogGroupItem
          key={group.key}
          group={group}
          issueTitle={
            group.issueRef ? issueTitles[issueTitleKey(group.repo, group.issueRef)] : undefined
          }
          // 最新グループ(先頭)だけ既定で開く。それ以外は折りたたみ。
          defaultOpen={index === 0}
          timeZone={timeZone}
          onUpdate={onUpdate}
          onDelete={onDelete}
        />
      ))}
    </ul>
  );
}

interface WorkLogGroupItemProps {
  group: WorkLogGroup;
  /** 解決できた issue/PR タイトル(open のみ引ける)。未解決・closed・issue 無しは undefined。 */
  issueTitle?: string;
  /** 初期表示で展開しておくか(最新グループのみ true を渡す想定)。 */
  defaultOpen: boolean;
  timeZone: string;
  onUpdate: (id: string, req: WorkLogUpdateRequest) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

/**
 * 実績履歴のグループ1つ(同じ repo+issue の記録のまとまり)。見出し行に repo・#issue番号
 * (issue 無しは repo のみ)・issue タイトル・合計時間・件数・最新日時を出し、クリックで
 * 展開/折りたたみ。420px 幅では見出しを2段(1段目=参照+タイトル、2段目=合計/件数/最新)に
 * 積んで、横並びで潰れないようにしている(GitHubPane.css 参照)。
 * 展開時は WorkLogHistoryRow(編集/削除)をグループ内 logs で描画する。手動/hook の混在は
 * 各行の agent バッジで区別できるので、見出しには出さない。
 */
function WorkLogGroupItem({
  group,
  issueTitle,
  defaultOpen,
  timeZone,
  onUpdate,
  onDelete,
}: WorkLogGroupItemProps) {
  const [open, setOpen] = useState(defaultOpen);
  // `repo #番号`(issue 無しは repo のみ)。issue タイトルが解決できていれば見出しに添える。
  const ref = group.issueRef ? `${group.repo} #${group.issueRef}` : group.repo;
  const title = group.issueRef ? issueTitle : undefined;
  // title 属性(ホバー)にはタイトル込みのフル見出しを入れる。
  const fullHeading = title ? `${ref} — ${title}` : ref;
  return (
    <li className="github-pane-group">
      <button
        type="button"
        className="github-pane-group-summary"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="github-pane-group-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="github-pane-group-body">
          <span className="github-pane-group-heading" title={fullHeading}>
            <span className="github-pane-group-heading-ref">{ref}</span>
            {title && <span className="github-pane-group-heading-title">{title}</span>}
          </span>
          <span className="github-pane-group-meta">
            <span className="github-pane-group-total">{formatDurationHm(group.totalMs)}</span>
            <span className="github-pane-group-count">{group.sessionCount}件</span>
            <span className="github-pane-group-latest">
              {formatWorkLogDateTime(group.latestStartMs, timeZone)}
            </span>
          </span>
        </span>
      </button>
      {open && (
        <ul className="github-pane-history-list github-pane-group-logs">
          {group.logs.map((log) => (
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
    </li>
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
 * 編集の保存・削除は非楽観更新 — onUpdate/onDelete 成功後に App.tsx が work-logs を再取得する。
 * 通常は再取得で本行ごと消える(または新しい値で置き換わる)が、再取得が失敗して旧リストが
 * 残ったときに操作不能な状態で固まらないよう、削除は成功・失敗のどちらでも view に戻す。
 * 420px 幅に収めるため、行は「repo/issue/agent」→「期間」→「操作」の縦積み(GitHubPane.css)。
 */
function WorkLogHistoryRow({ log, timeZone, onUpdate, onDelete }: WorkLogHistoryRowProps) {
  const [mode, setMode] = useState<RowMode>({ kind: "view" });
  const [deleteError, setDeleteError] = useState(false);
  const manual = isManualWorkLog(log);

  if (mode.kind === "editing") {
    return (
      <li className="github-pane-history-item github-pane-history-item--editing">
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
    <li className="github-pane-history-item">
      <span className="github-pane-history-main">
        <span className="github-pane-history-repo">{log.repo}</span>
        {log.issueRef && <span className="github-pane-history-issue">#{log.issueRef}</span>}
        <span
          className={
            manual
              ? "github-pane-history-badge github-pane-history-badge--manual"
              : "github-pane-history-badge"
          }
        >
          {log.agent ?? "(agent 不明)"}
        </span>
      </span>
      <span className="github-pane-history-time">
        {formatWorkLogRange(log.startMs, log.endMs, timeZone)}(
        {formatDurationHm(Math.max(0, log.endMs - log.startMs))})
      </span>
      {mode.kind === "confirm-delete" || mode.kind === "deleting" ? (
        <span className="github-pane-confirm">
          削除しますか？
          <button
            type="button"
            className="github-pane-text-btn"
            disabled={mode.kind === "deleting"}
            onClick={() => {
              setMode({ kind: "deleting" });
              setDeleteError(false);
              onDelete(log.id)
                .then(() => {
                  // 成功時も view に戻す。通常は再取得で本行ごと消える(アンマウント後の
                  // setState は React 19 では無視される)が、App.tsx の refetchWorkLogs は
                  // 再取得の失敗を握って旧リストを保持するため、行が残ったまま "deleting" で
                  // ボタンが無効に固まることがあった(2026-07-25 のレビュー指摘)。削除自体の
                  // 成否とリスト再取得の成否は別物として扱う。
                  setMode({ kind: "view" });
                })
                .catch((err) => {
                  console.error("kichijitsu: work log delete failed", err);
                  setDeleteError(true);
                  setMode({ kind: "view" });
                });
            }}
          >
            削除する
          </button>
          <button
            type="button"
            className="github-pane-text-btn"
            disabled={mode.kind === "deleting"}
            onClick={() => setMode({ kind: "view" })}
          >
            やめる
          </button>
        </span>
      ) : (
        <span className="github-pane-history-actions">
          <button
            type="button"
            className="github-pane-text-btn"
            onClick={() => setMode({ kind: "editing" })}
          >
            編集
          </button>
          <button
            type="button"
            className="github-pane-text-btn"
            onClick={() => setMode({ kind: "confirm-delete" })}
          >
            削除
          </button>
          {deleteError && <span className="github-pane-error">削除に失敗しました</span>}
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
 * → onUpdate(id, req)。repo は編集フォームでは1欄のまま("org/repo" をそのまま出す、手動記録
 * フォームのような org/repo 分割はしない)。agent 欄も見せる — hook 記録を編集するとき、現値
 * (例: claude-code)をそのまま送り返せば維持される(buildWorkLogUpdateRequest のコメント参照)。
 * 手動記録フォームと同じく、420px 幅に合わせて全フィールドを1列縦積みにしている。
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
    <div className="github-pane-form">
      <div className="github-pane-field">
        <span className="github-pane-label">repo</span>
        <input
          type="text"
          className="github-pane-input"
          value={form.repo}
          disabled={submitting}
          onChange={(e) => set("repo", e.target.value)}
        />
      </div>

      <div className="github-pane-field">
        <span className="github-pane-label">issue/PR番号(任意)</span>
        <input
          type="text"
          className="github-pane-input"
          placeholder="42"
          value={form.issueRef}
          disabled={submitting}
          onChange={(e) => set("issueRef", e.target.value)}
        />
      </div>

      <div className="github-pane-field">
        <span className="github-pane-label">開始</span>
        <input
          type="datetime-local"
          className="github-pane-input"
          value={form.startLocal}
          disabled={submitting}
          onChange={(e) => set("startLocal", e.target.value)}
        />
      </div>
      <div className="github-pane-field">
        <span className="github-pane-label">終了</span>
        <input
          type="datetime-local"
          className="github-pane-input"
          value={form.endLocal}
          disabled={submitting}
          onChange={(e) => set("endLocal", e.target.value)}
        />
      </div>

      <div className="github-pane-field">
        <span className="github-pane-label">agent</span>
        <input
          type="text"
          className="github-pane-input"
          placeholder="manual"
          value={form.agent}
          disabled={submitting}
          onChange={(e) => set("agent", e.target.value)}
        />
      </div>

      <div className="github-pane-submit-row">
        <button
          type="button"
          className="github-pane-save-btn"
          disabled={submitting}
          onClick={handleSave}
        >
          {submitting ? "保存中…" : "保存"}
        </button>
        <button
          type="button"
          className="github-pane-text-btn"
          disabled={submitting}
          onClick={onCancel}
        >
          キャンセル
        </button>
        {error && <span className="github-pane-error">{error}</span>}
      </div>
    </div>
  );
}
