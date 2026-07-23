import { useEffect, useMemo, useRef, useState } from "react";
import type {
  GitHubRepoIssue,
  GitHubRepoRef,
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
import {
  distinctIssueRepos,
  groupWorkLogsByIssue,
  issueTitleKey,
  summarizeWorkLogGroups,
  type WorkLogGroup,
} from "../sync/workLogGrouping";
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
  /** 手動追加フォームの org/repo プルダウン用に repo 一覧を取得する(isTauri 分岐は App 側で解決済み)。 */
  fetchRepos: () => Promise<GitHubRepoRef[]>;
  /** repo 選択時にその repo の open issue/PR を取得する(issue/PR プルダウン用)。 */
  fetchRepoIssues: (repo: string) => Promise<GitHubRepoIssue[]>;
  /**
   * 詳細レポート(予定 vs 実績、TimeReportOverlay)を開く導線。実績 UX 刷新(2026-07-23)で
   * 旧 GitHubPane 実績セクションの「詳細」ボタンをここへ移した。呼び出し側(App.tsx)は
   * このモーダルを閉じてからレポートを開く(閉じないと二重モーダルになるため)。省略時はボタン非表示。
   */
  onOpenReport?: () => void;
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
  fetchRepos,
  fetchRepoIssues,
  onOpenReport,
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
  // 実績履歴を同じ repo+issue の記録でまとめたグループ(グループ並びは最新記録の startMs 降順、
  // グループ内 logs は startMs 降順)。フラットな全件表示から、issue/PR 単位のまとめ表示へ。
  const historyGroups = useMemo(() => groupWorkLogsByIssue(workLogs), [workLogs]);
  const historySummary = useMemo(() => summarizeWorkLogGroups(historyGroups), [historyGroups]);
  // 実行中の開区間(= timeEntries のうち endMs===null)。フェーズ5b(2026-07-23)で走行状態は
  // サーバー開区間の射影になり、これには MCP など別経路で開始され作業キューに無いものも含む。
  const runningEntries = useMemo(
    () => timeEntries.filter((e) => e.endMs === null),
    [timeEntries],
  );
  // 実行中の linkedItemId 集合。作業キューのうち未走行のものだけ ▶ を出すために使う
  // (走行中の作業キュー item は上の「実行中」リストに開区間として現れる)。
  const runningLinkedIds = useMemo(
    () => new Set(runningEntries.map((e) => e.linkedItemId)),
    [runningEntries],
  );
  const idleQueue = useMemo(
    () => githubQueue.filter((item) => !runningLinkedIds.has(item.id)),
    [githubQueue, runningLinkedIds],
  );

  // 実績履歴のグループ見出しに出す issue/PR タイトルのルックアップ(`repo#番号 → title`)。
  // issue を持つグループの所属 repo を重複排除し、各 repo の open issue/PR 一覧を1回だけ取得して
  // 埋める。取得済み repo は fetchedIssueReposRef で覚えて二重取得を避ける。fetchRepoIssues は
  // open のみ返すため closed issue のタイトルは引けない — その場合は従来の `repo #番号` のまま。
  // 取得失敗は握って warn のみ(タイトルが出ないだけで履歴表示は止めない)。
  const [issueTitles, setIssueTitles] = useState<Record<string, string>>({});
  const fetchedIssueReposRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const targets = distinctIssueRepos(historyGroups).filter(
      (repo) => !fetchedIssueReposRef.current.has(repo),
    );
    if (targets.length === 0) return;
    let cancelled = false;
    for (const repo of targets) {
      // 先にマークして(取得中・失敗も含め)同じ repo を二重に取りにいかないようにする。
      fetchedIssueReposRef.current.add(repo);
      fetchRepoIssues(repo)
        .then((issues) => {
          if (cancelled) return;
          setIssueTitles((prev) => {
            const next = { ...prev };
            for (const issue of issues) {
              next[issueTitleKey(repo, issue.number)] = issue.title;
            }
            return next;
          });
        })
        .catch((err) => {
          console.warn(
            `kichijitsu: 実績履歴の issue タイトル取得に失敗 (${repo}、タイトルは省略)`,
            err,
          );
        });
    }
    return () => {
      cancelled = true;
    };
  }, [historyGroups, fetchRepoIssues]);

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
          <div className="work-log-modal-header-actions">
            {onOpenReport && (
              <button
                type="button"
                className="work-log-modal-report-btn"
                onClick={onOpenReport}
                title="issue / PR ごとの予定と実績を突き合わせたレポートを開きます"
              >
                詳細レポート(予定 vs 実績)
              </button>
            )}
            <button
              type="button"
              className="work-log-modal-close"
              onClick={onClose}
              aria-label="閉じる"
            >
              ×
            </button>
          </div>
        </div>

        <section className="work-log-modal-section">
          <h3 className="work-log-modal-section-title">タイマー(実行中・作業キュー)</h3>
          <p className="work-log-modal-section-desc">
            実行中のタイマー(サーバー共有の開区間)を上に、未計測の作業キュー issue/PR を下に
            表示します。▶ で計測を開始、⏹ で停止すると実績(work_log)として保存され、下の実績
            履歴に現れます(GitHubPane やヘッダーからも操作できます)。MCP など別経路で開始された
            計測(作業キューに無いもの)も実行中として表示します。
          </p>
          {runningEntries.length > 0 && (
            <ul className="work-log-modal-timer-list">
              {runningEntries.map((entry) => (
                <RunningEntryRow
                  key={entry.id}
                  entry={entry}
                  nowMs={nowMs}
                  onStopTimer={onStopTimer}
                />
              ))}
            </ul>
          )}
          {idleQueue.length > 0 && (
            <ul className="work-log-modal-timer-list">
              {idleQueue.map((item) => (
                <TimerQueueRow key={item.id} item={item} onStartTimer={onStartTimer} />
              ))}
            </ul>
          )}
          {runningEntries.length === 0 && idleQueue.length === 0 && (
            <p className="work-log-modal-empty">実行中の計測も未完了の issue/PR もありません</p>
          )}
        </section>

        <section className="work-log-modal-section">
          <h3 className="work-log-modal-section-title">実績を手動で記録</h3>
          <ManualWorkLogForm
            orgCandidates={orgCandidates}
            repoCandidates={repoCandidates}
            timeZone={timeZone}
            onCreate={onCreate}
            fetchRepos={fetchRepos}
            fetchRepoIssues={fetchRepoIssues}
          />
        </section>

        <section className="work-log-modal-section">
          <div className="work-log-modal-section-header">
            <h3 className="work-log-modal-section-title">実績履歴</h3>
            {historySummary.sessionCount > 0 && (
              <span className="work-log-modal-history-total">
                合計 <strong>{formatDurationHm(historySummary.totalMs)}</strong>
                <span className="work-log-modal-history-total-sub">
                  {" · "}
                  {historySummary.sessionCount}件 / {historySummary.groupCount}
                  グループ
                </span>
              </span>
            )}
          </div>
          <p className="work-log-modal-section-desc">
            手動で記録した実績と、hook(Claude Code 等)が自動記録した実績を、同じ issue/PR の記録
            ごとにまとめています(最新の記録が新しいグループから順)。見出しをクリックすると個別の
            記録が開き、それぞれ編集・削除できます — agent 欄で手動(manual)/hook の記録を
            見分けられます。
          </p>
          {historyGroups.length === 0 ? (
            <p className="work-log-modal-empty">まだ実績がありません</p>
          ) : (
            <ul className="work-log-modal-group-list">
              {historyGroups.map((group, index) => (
                <WorkLogGroupItem
                  key={group.key}
                  group={group}
                  issueTitle={
                    group.issueRef
                      ? issueTitles[issueTitleKey(group.repo, group.issueRef)]
                      : undefined
                  }
                  // 最新グループ(先頭)だけ既定で開く。それ以外は折りたたみ。
                  defaultOpen={index === 0}
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

interface RunningEntryRowProps {
  /** 実行中の開区間の射影(endMs===null)。作業キューに無い MCP 由来のものも来る */
  entry: TimeEntry;
  nowMs: number;
  onStopTimer: (linkedItemId: string) => void;
}

/**
 * 実行中の1行(フェーズ5b、2026-07-23)。サーバー開区間の射影 TimeEntry を「実行中(経過)+ ⏹」で
 * 出す。タイトルは補完できていればそれを、無ければ `repo #number` を見出しにする(MCP 由来など
 * 作業キューにも予定にも無い開区間はメタが引けず title が空文字になる)。⏹ は開区間の
 * linkedItemId で App.onStopTimer を呼ぶ(RunningTimersIndicator と同じ経路)。
 */
function RunningEntryRow({ entry, nowMs, onStopTimer }: RunningEntryRowProps) {
  const heading = entry.title.trim() ? entry.title : `${entry.repo} #${entry.number}`;
  return (
    <li className="work-log-modal-timer-item">
      <a
        className={`work-log-modal-timer-link work-log-modal-timer-link--${entry.itemType}`}
        href={entry.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`${entry.repo} #${entry.number} ${entry.title}`.trim()}
      >
        <span className="work-log-modal-timer-kind" aria-hidden="true">
          {entry.itemType === "pr" ? "PR" : "Iss"}
        </span>
        <span className="work-log-modal-timer-main">
          <span className="work-log-modal-timer-title">{heading}</span>
          <span className="work-log-modal-timer-meta">
            {entry.repo}
            {entry.number > 0 ? ` #${entry.number}` : ""}
          </span>
        </span>
      </a>
      <span className="work-log-modal-timer-elapsed" aria-live="polite">
        実行中 {formatDurationHm(entryDurationMs(entry, nowMs))}
      </span>
      <button
        type="button"
        className="work-log-modal-timer-btn work-log-modal-timer-btn--stop"
        onClick={() => onStopTimer(entry.linkedItemId)}
        aria-label={`${entry.repo} #${entry.number} のタイマーを停止`}
        title="停止して実績を保存"
      >
        ⏹
      </button>
    </li>
  );
}

interface TimerQueueRowProps {
  item: GitHubWorkItemDTO;
  onStartTimer: (item: TimerLinkedItem) => void;
}

/**
 * 未計測の作業キュー1行(フェーズ5b、2026-07-23)。走行中の item は上の「実行中」リストに
 * 開区間として出るため、この行は常に ▶(未走行)だけを出す。GitHubWorkItemDTO(shared)は
 * TimerLinkedItem を構造的に満たす(id→linkedItemId、type→itemType)ので、▶ 押下時にその形へ
 * 詰め替えて App.onStartTimer に渡す(サーバーに開区間を開始させる)。
 */
function TimerQueueRow({ item, onStartTimer }: TimerQueueRowProps) {
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
    </li>
  );
}

interface ManualWorkLogFormProps {
  orgCandidates: string[];
  repoCandidates: string[];
  timeZone: string;
  onCreate: (req: WorkLogCreateRequest) => Promise<void>;
  fetchRepos: () => Promise<GitHubRepoRef[]>;
  fetchRepoIssues: (repo: string) => Promise<GitHubRepoIssue[]>;
}

/** 非同期取得の状態機械(repos / repo-issues 共通)。 */
type LoadState = "idle" | "loading" | "loaded" | "error";

/**
 * 手動追加フォーム(実績 UX 刷新フェーズ3、2026-07-23)。サーバーの WorkLogCreateRequest は
 * repo 1フィールドのみだが、UI では org / repo / issue を実データのカスケードプルダウンにする:
 *   - org select: repo 一覧の owner を重複排除して昇順。
 *   - repo select: 選択中 org の repo を昇順。
 *   - issue/PR select: repo 選択時にその repo の open issue/PR を取得して表示。
 * 送信時は combineOrgRepo で "org/repo" へ結合し、issue は選んだ number を issueRef に入れる
 * (送信ボディの形は変えない、workLogEntry.ts のコメント参照)。
 *
 * repo 一覧はモーダルを開いた初回に一度だけ取得する。取得できない(未連携・gh 未ログイン・
 * オフライン等)ときは、従来どおり org/repo/issue を datalist 付きテキストで手入力できる
 * フォールバックへ切り替える — プルダウンの元データが無くても実績記録という主機能を止めない
 * ため(この画面は「実績を残す」ことが目的で、repo 選択はあくまでその補助)。issue の取得失敗も
 * 同様に番号のテキスト手入力へフォールバックする。
 */
function ManualWorkLogForm({
  orgCandidates,
  repoCandidates,
  timeZone,
  onCreate,
  fetchRepos,
  fetchRepoIssues,
}: ManualWorkLogFormProps) {
  const [org, setOrg] = useState("");
  const [repo, setRepo] = useState("");
  const [issueRef, setIssueRef] = useState("");
  const [startLocal, setStartLocal] = useState("");
  const [endLocal, setEndLocal] = useState("");
  const [agent, setAgent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // repo 一覧(プルダウンの元データ)。モーダルを開いた初回に一度だけ取得する。
  const [repos, setRepos] = useState<GitHubRepoRef[]>([]);
  const [reposState, setReposState] = useState<LoadState>("idle");
  // 選択中 repo の open issue/PR。repo 選択が変わるたびに取り直す。
  const [issues, setIssues] = useState<GitHubRepoIssue[]>([]);
  const [issuesState, setIssuesState] = useState<LoadState>("idle");

  useEffect(() => {
    let cancelled = false;
    setReposState("loading");
    fetchRepos()
      .then((list) => {
        if (cancelled) return;
        setRepos(list);
        setReposState("loaded");
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("kichijitsu: repo 一覧の取得に失敗(手入力にフォールバック)", err);
        setReposState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [fetchRepos]);

  // プルダウンを使えるのは「取得成功かつ1件以上」のときだけ。それ以外(取得失敗・0件)は
  // テキスト手入力へフォールバックする。
  const usePulldown = reposState === "loaded" && repos.length > 0;

  // org プルダウンの選択肢: owner を重複排除して昇順。
  const orgOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of repos) set.add(r.owner);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [repos]);

  // repo プルダウンの選択肢: 選択中 org の repo を昇順。
  const repoOptions = useMemo(() => {
    if (!org) return [];
    return repos
      .filter((r) => r.owner === org)
      .map((r) => r.repo)
      .sort((a, b) => a.localeCompare(b));
  }, [repos, org]);

  // repo が確定したら issue/PR を取得する(プルダウン時のみ)。org か repo が変われば取り直す。
  useEffect(() => {
    if (!usePulldown || !org || !repo) {
      setIssues([]);
      setIssuesState("idle");
      return;
    }
    let cancelled = false;
    setIssuesState("loading");
    setIssues([]);
    fetchRepoIssues(`${org}/${repo}`)
      .then((list) => {
        if (cancelled) return;
        setIssues(list);
        setIssuesState("loaded");
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("kichijitsu: issue/PR 一覧の取得に失敗(番号手入力にフォールバック)", err);
        setIssuesState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [usePulldown, org, repo, fetchRepoIssues]);

  function resetForm() {
    setOrg("");
    setRepo("");
    setIssueRef("");
    setStartLocal("");
    setEndLocal("");
    setAgent("");
    setIssues([]);
    setIssuesState("idle");
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

  // issue/PR の入力領域。プルダウン時は取得状態に応じて select / 番号手入力を出し分ける。
  function renderIssueField() {
    // フォールバック(repos が取れない): 番号を直接手入力。
    if (!usePulldown) {
      return (
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
      );
    }
    if (!org || !repo) {
      return (
        <div className="work-log-modal-field">
          <span className="work-log-modal-label">issue/PR(任意)</span>
          <select className="work-log-modal-input" disabled value="">
            <option value="">repo を選ぶと一覧が出ます</option>
          </select>
        </div>
      );
    }
    if (issuesState === "loading") {
      return (
        <div className="work-log-modal-field">
          <span className="work-log-modal-label">issue/PR(任意)</span>
          <select className="work-log-modal-input" disabled value="">
            <option value="">読み込み中…</option>
          </select>
        </div>
      );
    }
    // 取得失敗 or 0件: 番号を直接手入力できるフォールバック。
    if (issuesState === "error" || issues.length === 0) {
      return (
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
          <span className="work-log-modal-hint">
            {issuesState === "error"
              ? "一覧を取得できませんでした。番号を直接入力できます"
              : "open な issue/PR はありません。番号を直接入力できます"}
          </span>
        </div>
      );
    }
    // 取得成功: プルダウン。
    return (
      <div className="work-log-modal-field">
        <span className="work-log-modal-label">issue/PR(任意)</span>
        <select
          className="work-log-modal-input"
          value={issueRef}
          disabled={submitting}
          onChange={(e) => setIssueRef(e.target.value)}
        >
          <option value="">(選択しない)</option>
          {issues.map((i) => (
            <option key={`${i.type}-${i.number}`} value={String(i.number)}>
              {i.type === "pr" ? "PR" : "Issue"} #{i.number} {i.title}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div className="work-log-modal-form">
      {reposState === "loading" && (
        <span className="work-log-modal-hint">リポジトリ一覧を読み込み中…</span>
      )}
      {reposState === "error" && (
        <span className="work-log-modal-hint">
          リポジトリ一覧を取得できませんでした。org / repo は手入力してください
        </span>
      )}

      {usePulldown ? (
        <div className="work-log-modal-field-row">
          <div className="work-log-modal-field">
            <span className="work-log-modal-label">org</span>
            <select
              className="work-log-modal-input"
              value={org}
              disabled={submitting}
              onChange={(e) => {
                setOrg(e.target.value);
                // org を変えたら repo / issue の選択はリセットする(整合性のため)。
                setRepo("");
                setIssueRef("");
              }}
            >
              <option value="">org を選択</option>
              {orgOptions.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
          <div className="work-log-modal-field">
            <span className="work-log-modal-label">repo</span>
            <select
              className="work-log-modal-input"
              value={repo}
              disabled={submitting || !org}
              onChange={(e) => {
                setRepo(e.target.value);
                setIssueRef("");
              }}
            >
              <option value="">{org ? "repo を選択" : "先に org を選択"}</option>
              {repoOptions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : (
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
      )}

      {renderIssueField()}

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
 * 実績履歴のグループ1つ(同じ repo+issue の記録のまとまり、2026-07-23)。見出し行に repo・
 * #issue番号(issue 無しは repo のみ)・合計時間・件数・最新日時を出し、クリックで展開/折りたたみ。
 * 開閉はローカル state(既定は折りたたみ、呼び出し側が defaultOpen=true を渡した最新グループのみ開く)。
 * 展開時は既存の WorkLogHistoryRow(編集/削除)をグループ内 logs で描画する — 個別の編集・削除
 * 挙動は従来のまま。手動/hook の混在は各行の agent バッジで区別できるので、見出しには出さない。
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
    <li className="work-log-modal-group">
      <button
        type="button"
        className="work-log-modal-group-summary"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="work-log-modal-group-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="work-log-modal-group-heading" title={fullHeading}>
          <span className="work-log-modal-group-heading-ref">{ref}</span>
          {title && <span className="work-log-modal-group-heading-title">{title}</span>}
        </span>
        <span className="work-log-modal-group-meta">
          <span className="work-log-modal-group-total">{formatDurationHm(group.totalMs)}</span>
          <span className="work-log-modal-group-count">{group.sessionCount}件</span>
          <span className="work-log-modal-group-latest">{formatWorkLogDate(group.latestStartMs)}</span>
        </span>
      </button>
      {open && (
        <ul className="work-log-modal-history-list work-log-modal-group-logs">
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

/** グループ見出しの「最新日時」表示。epoch ms を "M/D H:mm" 形式に整形する
 * (formatWorkLogRange と同じロケール非依存の簡易フォーマット)。 */
function formatWorkLogDate(startMs: number): string {
  const d = new Date(startMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
