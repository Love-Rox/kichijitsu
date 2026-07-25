import { useMemo, useRef } from "react";
import type {
  GitHubRepoIssue,
  GitHubRepoRef,
  GitHubWorkItemDTO,
  WorkLogCreateRequest,
  WorkLogDTO,
  WorkLogUpdateRequest,
} from "@kichijitsu/shared";
import type { PlannedBlock, TimeEntry } from "../model/types";
import { splitRunningAndIdleQueue } from "../sync/workQueue";
import { entryDurationMs, formatDurationHm, type TimerLinkedItem } from "../sync/timeTracking";
import { collectWorkLogOrgCandidates, collectWorkLogRepoCandidates } from "../sync/workLogEntry";
import { groupWorkLogsByIssue, summarizeWorkLogGroups } from "../sync/workLogGrouping";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import type { PaneMode } from "../layout/paneMode";
import { PanelIcon, PinIcon } from "./icons";
import { PaneSection } from "./PaneSection";
import { WorkQueueSection } from "./WorkQueueSection";
import { ManualWorkLogForm } from "./ManualWorkLogForm";
import { WorkLogHistory } from "./WorkLogHistory";
import "./GitHubPane.css";

export interface GitHubPaneProps {
  mode: PaneMode;
  onModeChange: (mode: PaneMode) => void;
  onClose: () => void;
  /** 狭幅(isNarrow)のとき true — モード切替ボタン自体を出さない(常に overlay 固定のため) */
  disableModeToggle: boolean;
  // 作業キューセクション(docs/github-integration.md フェーズ②Part B)
  items: GitHubWorkItemDTO[];
  loading: boolean;
  authExpired: boolean;
  onRefresh: () => void;
  onReconnect: () => void;
  /**
   * ドラッグでのタイムブロック化(docs/github-integration.md「時間計測」増分1)開始時に
   * 呼ばれる。overlay モードは fixed backdrop でグリッドの上に被さっているため、開いたままだと
   * グリッドへドロップできない ―― App.tsx はこれを受けてペインを閉じる(仕様どおり
   * 「ドラッグ中は閉じてよい」)。docked モードは常設フローなのでレイアウト上はドロップの妨げに
   * ならないが、増分1では overlay/docked どちらでも同じ挙動(閉じる)で揃える。
   * dataTransfer への setData は dragstart 同期実行内で完了済みなので、直後にこの
   * コンポーネントがアンマウントされてもドラッグ操作自体はブラウザ側で継続する。
   */
  onDragStart: () => void;

  // ── 実績(旧 WorkLogModal から移設、2026-07-25)────────────────────────────
  /** 実績履歴の元データ(全件)。グループ化・合計は sync/workLogGrouping.ts の純関数に任せる */
  workLogs: WorkLogDTO[];
  /** 手動記録フォームの org/repo サジェスト候補を作るために使う(collectWorkLog*Candidates) */
  plannedBlocks: PlannedBlock[];
  /** 走行中判定・経過表示用の全 TimeEntry(endMs===null が走行中、サーバー開区間の射影) */
  timeEntries: TimeEntry[];
  /** 経過時間表示に使う現在時刻(App.tsx の timerNowMs、走行中があるとき1秒 tick で更新) */
  nowMs: number;
  /** ▶ から呼ばれる。走行中エントリ(サーバー開区間)を開始する(App.onStartTimer) */
  onStartTimer: (item: TimerLinkedItem) => void;
  /** ⏹ から呼ばれる。対象を停止して work_logs へ保存する(App.onStopTimer) */
  onStopTimer: (linkedItemId: string) => void;
  /** datetime-local の入力/表示をアプリ設定のタイムゾーンのローカル壁時計として解釈するために使う */
  timeZone: string;
  /** 実績を手動で追加する。成功後は App.tsx が work-logs を再取得して反映する(非楽観更新) */
  onCreateWorkLog: (req: WorkLogCreateRequest) => Promise<void>;
  /** 既存の実績を部分更新する(PATCH /api/work-logs/:id)。成功後は App.tsx が再取得する */
  onUpdateWorkLog: (id: string, req: WorkLogUpdateRequest) => Promise<void>;
  /** 実績を削除する(DELETE /api/work-logs/:id)。成功後は App.tsx が再取得する */
  onDeleteWorkLog: (id: string) => Promise<void>;
  /** 手動記録フォームの org/repo プルダウン用に repo 一覧を取得する(isTauri 分岐は App 側で解決済み) */
  fetchRepos: () => Promise<GitHubRepoRef[]>;
  /** repo 選択時にその repo の open issue/PR を取得する(issue/PR プルダウン・履歴のタイトル補完) */
  fetchRepoIssues: (repo: string) => Promise<GitHubRepoIssue[]>;
  /**
   * 詳細レポート(予定 vs 実績、TimeReportOverlay)を開く導線。レポートだけはモーダルのまま
   * 残してあるので、ペインからはこのボタン1つで開く(ペインは開いたままでよい ―― docked なら
   * 併存でき、overlay でもモーダルが上に載るだけ)。省略時はボタン非表示。
   */
  onOpenReport?: () => void;
}

/**
 * GitHub 情報ペイン(docs/github-integration.md フェーズ②Part B → 増分1でセクション式
 * コンテナへ発展 → 2026-07-25 に実績モーダル(WorkLogModal)を全面吸収)。
 *
 * 「カレンダーを見ながら記録・履歴・タイマーを扱いたい」というユーザー要望により、モーダル開閉で
 * カレンダーが隠れる WorkLogModal を廃止し、その全機能(実行中タイマー・作業キュー・実績の手動
 * 記録・実績履歴・詳細レポート導線)をこのペインへ集約した。右ペイン = 作業のすべて(計画+進行+
 * 記録)、モーダルは詳細レポート(TimeReportOverlay)だけ、という役割分担になっている。
 *
 * セクション構成(上から。すべて PaneSection によるアコーディオン):
 *   1. 実行中(既定で開く)   … サーバー開区間の射影。経過時間 + ⏹。
 *   2. 作業キュー(既定で開く) … 未計測の issue/PR。▶ で計測開始、行はグリッドへドラッグして予定化。
 *   3. 実績を手動で記録(既定で閉じる) … org→repo→issue のカスケード + 開始/終了 + agent。
 *   4. 実績履歴(既定で閉じる)     … issue/PR 単位のグループ表示、展開して編集/削除。
 * 実行中の item は 1 に出し、2 からは除く(splitRunningAndIdleQueue、同じ item が二重に並ばない
 * ようにする ―― 旧 WorkLogModal のタイマー節と同じ考え方)。折りたたみ中はセクション本体を
 * アンマウントするため、手動記録フォームの repo 一覧取得・実績履歴の issue タイトル補完は
 * 「開いたときだけ」走る。
 *
 * 2026-07-25 のリファクタ フェーズ1b で、セクション本体はファイル分割した(このファイルは骨組み +
 * 「実行中」セクションのみ): 作業キュー → WorkQueueSection.tsx、手動記録 → ManualWorkLogForm.tsx、
 * 実績履歴 → WorkLogHistory.tsx、アコーディオン → PaneSection.tsx。CSS は分割せず GitHubPane.css
 * のまま(クラス名も据え置き)で、その import もこの1ファイルに集約している。
 *
 * overlay/docked の2つの配置モードを持つ(PaneMode、layout/paneMode.ts):
 *   - overlay: fixed backdrop + 右からスライドインする常設サイドレール。外側クリック・Escape で閉じる。
 *   - docked: グリッドの右に常設する flex サイドバー(position: fixed を使わず、通常の flex
 *     アイテムとしてレイアウトに参加しグリッド側を flex-shrink させる)。常設が主旨のため
 *     外側クリック・Escape では閉じない(明示的な閉じるボタンのみ)。
 */
export function GitHubPane({
  mode,
  onModeChange,
  onClose,
  disableModeToggle,
  items,
  loading,
  authExpired,
  onRefresh,
  onReconnect,
  onDragStart,
  workLogs,
  plannedBlocks,
  timeEntries,
  nowMs,
  onStartTimer,
  onStopTimer,
  timeZone,
  onCreateWorkLog,
  onUpdateWorkLog,
  onDeleteWorkLog,
  fetchRepos,
  fetchRepoIssues,
  onOpenReport,
}: GitHubPaneProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const isOverlay = mode === "overlay";
  // docked(常設)は外側クリック・Escape では閉じない — active=false でリスナー自体を張らない
  useCloseOnOutsideOrEscape(isOverlay, cardRef, onClose);

  // 実行中(サーバー開区間の射影)と未計測キューの分離。判定は sync/workQueue.ts の純関数。
  const { runningEntries, idleQueue } = useMemo(
    () => splitRunningAndIdleQueue(items, timeEntries),
    [items, timeEntries],
  );

  const repoCandidates = useMemo(
    () => collectWorkLogRepoCandidates(workLogs, plannedBlocks),
    [workLogs, plannedBlocks],
  );
  const orgCandidates = useMemo(
    () => collectWorkLogOrgCandidates(workLogs, plannedBlocks),
    [workLogs, plannedBlocks],
  );
  // 実績履歴を同じ repo+issue の記録でまとめたグループ(グループ並びは最新記録の startMs 降順、
  // グループ内 logs は startMs 降順)。合計はセクション見出しに出すので折りたたみ中も計算する。
  const historyGroups = useMemo(() => groupWorkLogsByIssue(workLogs), [workLogs]);
  const historySummary = useMemo(() => summarizeWorkLogGroups(historyGroups), [historyGroups]);

  const paneRoot = (
    <div
      className={isOverlay ? "github-pane github-pane--overlay" : "github-pane github-pane--docked"}
      ref={cardRef}
      role={isOverlay ? "dialog" : undefined}
      aria-label="GitHub"
    >
      <div className="github-pane-header">
        <span className="github-pane-title">GitHub</span>
        <div className="github-pane-actions">
          {!disableModeToggle && (
            <button
              type="button"
              className="github-pane-mode-btn"
              onClick={() => onModeChange(isOverlay ? "docked" : "overlay")}
              aria-label={isOverlay ? "常設ドッキングに切り替え" : "オーバーレイに切り替え"}
              title={isOverlay ? "常設ドッキングに切り替え" : "オーバーレイに切り替え"}
            >
              <span aria-hidden="true">{isOverlay ? <PinIcon /> : <PanelIcon />}</span>
            </button>
          )}
          <button
            type="button"
            className="github-pane-close-btn"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </div>
      </div>

      <div className="github-pane-body">
        <RunningSection entries={runningEntries} nowMs={nowMs} onStopTimer={onStopTimer} />
        <WorkQueueSection
          items={idleQueue}
          loading={loading}
          authExpired={authExpired}
          onRefresh={onRefresh}
          onReconnect={onReconnect}
          onDragStart={onDragStart}
          onStartTimer={onStartTimer}
        />
        <PaneSection title="実績を手動で記録" defaultOpen={false}>
          <p className="github-pane-section-desc">
            タイマーを使わなかった作業を後から記録します。開始/終了は表示中のタイムゾーンの
            ローカル時刻として解釈します。
          </p>
          <ManualWorkLogForm
            orgCandidates={orgCandidates}
            repoCandidates={repoCandidates}
            timeZone={timeZone}
            onCreate={onCreateWorkLog}
            fetchRepos={fetchRepos}
            fetchRepoIssues={fetchRepoIssues}
          />
        </PaneSection>
        <PaneSection
          title="実績履歴"
          defaultOpen={false}
          meta={
            historySummary.sessionCount > 0 ? (
              <>
                <span className="github-pane-section-meta-strong">
                  {formatDurationHm(historySummary.totalMs)}
                </span>
                {` · ${historySummary.sessionCount}件`}
              </>
            ) : undefined
          }
        >
          <p className="github-pane-section-desc">
            手動記録と hook(Claude Code 等)の自動記録を、同じ issue/PR ごとにまとめています。
            見出しを開くと個別の記録を編集・削除できます。
          </p>
          <WorkLogHistory
            groups={historyGroups}
            timeZone={timeZone}
            onUpdate={onUpdateWorkLog}
            onDelete={onDeleteWorkLog}
            fetchRepoIssues={fetchRepoIssues}
          />
        </PaneSection>
        {onOpenReport && (
          <button
            type="button"
            className="github-pane-report-btn"
            onClick={onOpenReport}
            title="issue / PR ごとの予定と実績を突き合わせたレポートを開きます"
          >
            詳細レポート(予定 vs 実績)を開く
          </button>
        )}
      </div>
    </div>
  );

  if (isOverlay) {
    return <div className="github-pane-backdrop">{paneRoot}</div>;
  }
  return paneRoot;
}

interface RunningSectionProps {
  entries: TimeEntry[];
  nowMs: number;
  onStopTimer: (linkedItemId: string) => void;
}

/**
 * 実行中セクション(旧 WorkLogModal のタイマー節の前半、2026-07-25)。サーバー開区間の射影を
 * そのまま並べる ―― 作業キューに無い MCP 由来の計測もここに出る。既定で開く(進行中の作業は
 * ペインを開いた瞬間に見えているべきなので)。
 */
function RunningSection({ entries, nowMs, onStopTimer }: RunningSectionProps) {
  return (
    <PaneSection
      title="実行中"
      defaultOpen
      meta={entries.length > 0 ? `${entries.length}件` : undefined}
    >
      {entries.length === 0 ? (
        <p className="github-pane-empty">実行中の計測はありません</p>
      ) : (
        <ul className="github-pane-timer-list">
          {entries.map((entry) => (
            <RunningEntryRow key={entry.id} entry={entry} nowMs={nowMs} onStopTimer={onStopTimer} />
          ))}
        </ul>
      )}
    </PaneSection>
  );
}

interface RunningEntryRowProps {
  /** 実行中の開区間の射影(endMs===null)。作業キューに無い MCP 由来のものも来る */
  entry: TimeEntry;
  nowMs: number;
  onStopTimer: (linkedItemId: string) => void;
}

/**
 * 実行中の1行。タイトルは補完できていればそれを、無ければ `repo #number` を見出しにする
 * (MCP 由来など作業キューにも予定にも無い開区間はメタが引けず title が空文字になる)。
 * ⏹ は開区間の linkedItemId で App.onStopTimer を呼ぶ(RunningTimersIndicator と同じ経路)。
 */
function RunningEntryRow({ entry, nowMs, onStopTimer }: RunningEntryRowProps) {
  const heading = entry.title.trim() ? entry.title : `${entry.repo} #${entry.number}`;
  return (
    <li className="github-pane-timer-item">
      <a
        className={`github-pane-timer-link github-pane-timer-link--${entry.itemType}`}
        href={entry.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`${entry.repo} #${entry.number} ${entry.title}`.trim()}
      >
        <span className="github-pane-timer-kind" aria-hidden="true">
          {entry.itemType === "pr" ? "PR" : "Iss"}
        </span>
        <span className="github-pane-timer-main">
          <span className="github-pane-timer-title">{heading}</span>
          <span className="github-pane-timer-meta">
            {entry.repo}
            {entry.number > 0 ? ` #${entry.number}` : ""}
          </span>
        </span>
      </a>
      <span className="github-pane-timer-elapsed" aria-live="polite">
        {formatDurationHm(entryDurationMs(entry, nowMs))}
      </span>
      <button
        type="button"
        className="github-pane-timer-btn github-pane-timer-btn--stop"
        onClick={() => onStopTimer(entry.linkedItemId)}
        aria-label={`${entry.repo} #${entry.number} のタイマーを停止`}
        title="停止して実績を保存"
      >
        ⏹
      </button>
    </li>
  );
}
