import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, ReactNode } from "react";
import type {
  GitHubRepoIssue,
  GitHubRepoRef,
  GitHubWorkItemDTO,
  WorkLogCreateRequest,
  WorkLogDTO,
  WorkLogUpdateRequest,
} from "@kichijitsu/shared";
import type { PlannedBlock, TimeEntry } from "../model/types";
import { groupWorkItemsByKind } from "../sync/workQueue";
import { WORKITEM_DND_MIME } from "../sync/planned";
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
import type { PaneMode } from "../layout/paneMode";
import { PanelIcon, PinIcon } from "./icons";
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
 * 実行中の item は 1 に出し、2 からは除く(同じ item が二重に並ばないようにする ―― 旧
 * WorkLogModal のタイマー節と同じ考え方)。折りたたみ中はセクション本体をアンマウントするため、
 * 手動記録フォームの repo 一覧取得・実績履歴の issue タイトル補完は「開いたときだけ」走る。
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

  // 実行中の開区間(= timeEntries のうち endMs===null)。走行状態はサーバー開区間の射影なので、
  // MCP など別経路で開始され作業キューに無いものもここに含まれる。
  const runningEntries = useMemo(() => timeEntries.filter((e) => e.endMs === null), [timeEntries]);
  // 実行中の linkedItemId 集合。作業キューからは走行中のものを除き、上の「実行中」だけに出す。
  const runningLinkedIds = useMemo(
    () => new Set(runningEntries.map((e) => e.linkedItemId)),
    [runningEntries],
  );
  const idleQueue = useMemo(
    () => items.filter((item) => !runningLinkedIds.has(item.id)),
    [items, runningLinkedIds],
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

interface PaneSectionProps {
  title: string;
  /** 初期表示で開いておくか。開閉はローカル state のみ(永続化しない) */
  defaultOpen: boolean;
  /** 見出しに添える補助情報(件数・合計時間など)。トグルボタンの中に入る */
  meta?: ReactNode;
  /**
   * 見出し行の右端に置くセクション固有のアクション(作業キューの更新ボタンなど)。トグル
   * ボタンの「外」に置く ―― button の入れ子は不正な HTML になるため。
   */
  action?: ReactNode;
  children: ReactNode;
}

/**
 * ペイン内セクションのアコーディオン(2026-07-25)。実績モーダル吸収でセクションが4つに増え、
 * 420px 幅に全部を常時展開すると縦に伸びすぎるため、見出しをトグルボタン化した。見出しは
 * <h3> が <button> を包む標準的なアコーディオンの形にしてある(button の中に見出し要素を
 * 置くと phrasing content 違反になるため逆にはできない)。aria-expanded で開閉を伝え、
 * focus-visible のアウトラインは他のペイン内ボタンと同じ朱。
 *
 * 折りたたみ中は children をアンマウントする(display:none ではない) ―― 実績履歴の issue
 * タイトル補完や手動記録フォームの repo 一覧取得のような「マウント時に走る取得」を、開いた
 * ときだけに限定するのが狙い。
 */
function PaneSection({ title, defaultOpen, meta, action, children }: PaneSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="github-pane-section">
      <div className="github-pane-section-header">
        <h3 className="github-pane-section-heading">
          <button
            type="button"
            className="github-pane-section-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="github-pane-section-caret" aria-hidden="true">
              {open ? "▾" : "▸"}
            </span>
            <span className="github-pane-section-title">{title}</span>
            {meta && <span className="github-pane-section-meta">{meta}</span>}
          </button>
        </h3>
        {action}
      </div>
      {open && <div className="github-pane-section-body">{children}</div>}
    </section>
  );
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
            <RunningEntryRow
              key={entry.id}
              entry={entry}
              nowMs={nowMs}
              onStopTimer={onStopTimer}
            />
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

interface WorkQueueSectionProps {
  /** 未計測の作業キュー(走行中の item は「実行中」セクションに出すため呼び出し側で除いてある) */
  items: GitHubWorkItemDTO[];
  loading: boolean;
  authExpired: boolean;
  onRefresh: () => void;
  onReconnect: () => void;
  onDragStart: () => void;
  onStartTimer: (item: TimerLinkedItem) => void;
}

/**
 * 作業キューセクション(docs/github-integration.md フェーズ②Part B)。セクション固有の
 * データ操作である更新ボタン(onRefresh)は、アコーディオンのトグルとは別のボタンとして
 * 見出し行の右端に置く(PaneSection の action)。
 *
 * 2026-07-25 の実績モーダル吸収で各行に ▶(計測開始)を足した ―― 旧 WorkLogModal の
 * TimerQueueRow が持っていた導線。グリッドへのドラッグ予定化は従来どおり維持している
 * (WorkQueueItemRow のコメント参照)。
 */
function WorkQueueSection({
  items,
  loading,
  authExpired,
  onRefresh,
  onReconnect,
  onDragStart,
  onStartTimer,
}: WorkQueueSectionProps) {
  const sections = groupWorkItemsByKind(items);
  const isEmpty = items.length === 0;
  // 初回ロード(まだ何も持っていない)だけスケルトンを出す。onRefresh での再取得中は
  // 直前のリストを表示したまま(更新ボタン側の「…」表示だけで進行を伝える)
  const showSkeleton = loading && isEmpty;

  return (
    <PaneSection
      title="作業キュー"
      defaultOpen
      meta={items.length > 0 ? `${items.length}件` : undefined}
      action={
        <button
          type="button"
          className="github-pane-refresh-btn"
          onClick={onRefresh}
          disabled={loading}
          aria-label="作業キューを更新"
          title="更新"
        >
          {loading ? "…" : "⟳"}
        </button>
      }
    >
      {authExpired && (
        <div className="github-pane-auth-expired">
          <p>GitHub の認可が切れました。</p>
          <button type="button" className="github-pane-reconnect-btn" onClick={onReconnect}>
            再連携
          </button>
        </div>
      )}

      {showSkeleton ? (
        <WorkQueueSkeleton />
      ) : isEmpty ? (
        authExpired ? null : (
          <p className="github-pane-empty-all">未計測の作業キューはありません</p>
        )
      ) : (
        sections.map((section) => (
          <div className="github-pane-kind-group" key={section.kind}>
            <h4 className="github-pane-kind-title">{section.label}</h4>
            {section.items.length === 0 ? (
              <p className="github-pane-kind-empty">該当なし</p>
            ) : (
              <ul className="github-pane-item-list">
                {section.items.map((item) => (
                  <li key={`${section.kind}:${item.id}`}>
                    <WorkQueueItemRow
                      item={item}
                      onDragStart={onDragStart}
                      onStartTimer={onStartTimer}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))
      )}
    </PaneSection>
  );
}

interface WorkQueueItemRowProps {
  item: GitHubWorkItemDTO;
  onDragStart: () => void;
  onStartTimer: (item: TimerLinkedItem) => void;
}

/**
 * 作業キュー1行。GitHubLane.tsx の item チップと同じ流儀 — <a target="_blank"> で
 * GitHub 側の画面をそのまま新規タブで開く(onClick+window.open ではなくネイティブリンクの
 * 挙動をそのまま活かす)。type バッジの色も GitHubLane と揃える(issue=紫 #6e5494/PR=緑 #0b8043)。
 *
 * ドラッグ→タイムブロック化(docs/github-integration.md「時間計測」増分1): draggable は
 * <a> 自身ではなく外側の div ラッパに付ける(<a> はネイティブに draggable=true なリンクなので、
 * そちらに付けると URL のドラッグ(text/uri-list)と競合し、狙った独自 MIME
 * (WORKITEM_DND_MIME) の dragstart がうまく発火しないことがある)。<a> 側は
 * draggable={false} で明示的に無効化し、クリック(新規タブで開く)はそのまま維持する。
 *
 * ▶(計測開始、2026-07-25 に旧 WorkLogModal から移設)はラッパの中に置くが draggable={false}
 * を付ける ―― ボタンからドラッグを開始できてしまうと「押したつもりがドラッグ」になるため。
 * GitHubWorkItemDTO(shared)は TimerLinkedItem を構造的に満たす(id→linkedItemId、
 * type→itemType)ので、押下時にその形へ詰め替えて App.onStartTimer に渡す。
 */
function WorkQueueItemRow({ item, onDragStart, onStartTimer }: WorkQueueItemRowProps) {
  function handleDragStart(e: ReactDragEvent<HTMLDivElement>) {
    const payload: Pick<GitHubWorkItemDTO, "id" | "type" | "title" | "repo" | "number" | "url"> = {
      id: item.id,
      type: item.type,
      title: item.title,
      repo: item.repo,
      number: item.number,
      url: item.url,
    };
    e.dataTransfer.setData(WORKITEM_DND_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "copy";
    onDragStart();
  }

  return (
    <div className="github-pane-item-row" draggable onDragStart={handleDragStart}>
      <a
        className={`github-pane-item github-pane-item--${item.type}`}
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`${item.repo} #${item.number} ${item.title}`}
        draggable={false}
      >
        <span className="github-pane-item-kind" aria-hidden="true">
          {item.type === "pr" ? "PR" : "Iss"}
        </span>
        <span className="github-pane-item-main">
          <span className="github-pane-item-title">{item.title}</span>
          <span className="github-pane-item-meta">
            {item.repo} #{item.number}
          </span>
        </span>
      </a>
      <button
        type="button"
        className="github-pane-timer-btn github-pane-timer-btn--start"
        draggable={false}
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
    </div>
  );
}

/** 初回ロード中のプレースホルダ(装飾のみ、支援技術には無視させる) */
function WorkQueueSkeleton() {
  return (
    <div className="github-pane-skeleton" aria-hidden="true">
      <div className="github-pane-skeleton-line" />
      <div className="github-pane-skeleton-line" />
      <div className="github-pane-skeleton-line github-pane-skeleton-line--short" />
    </div>
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
 * 手動記録フォーム(旧 WorkLogModal から移設、2026-07-25)。サーバーの WorkLogCreateRequest は
 * repo 1フィールドのみだが、UI では org / repo / issue を実データのカスケードプルダウンにする:
 *   - org select: repo 一覧の owner を重複排除して昇順。
 *   - repo select: 選択中 org の repo を昇順。
 *   - issue/PR select: repo 選択時にその repo の open issue/PR を取得して表示。
 * 送信時は combineOrgRepo で "org/repo" へ結合し、issue は選んだ number を issueRef に入れる
 * (送信ボディの形は変えない、workLogEntry.ts のコメント参照)。
 *
 * repo 一覧はセクションを開いた初回に一度だけ取得する。取得できない(未連携・gh 未ログイン・
 * オフライン等)ときは、org/repo/issue を datalist 付きテキストで手入力できるフォールバックへ
 * 切り替える — プルダウンの元データが無くても実績記録という主機能を止めないため。issue の取得
 * 失敗も同様に番号のテキスト手入力へフォールバックする。
 *
 * レイアウトは 420px の右ペインに合わせて1列縦積み(モーダル時代の org/repo・開始/終了の
 * 横並びは廃止 ―― datetime-local は最小幅が大きく、420px の半分では入力欄が潰れるため)。
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

  // repo 一覧(プルダウンの元データ)。セクションを開いた初回に一度だけ取得する。
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
        <div className="github-pane-field">
          <span className="github-pane-label">issue/PR番号(任意)</span>
          <input
            type="text"
            className="github-pane-input"
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
        <div className="github-pane-field">
          <span className="github-pane-label">issue/PR(任意)</span>
          <select className="github-pane-input" disabled value="">
            <option value="">repo を選ぶと一覧が出ます</option>
          </select>
        </div>
      );
    }
    if (issuesState === "loading") {
      return (
        <div className="github-pane-field">
          <span className="github-pane-label">issue/PR(任意)</span>
          <select className="github-pane-input" disabled value="">
            <option value="">読み込み中…</option>
          </select>
        </div>
      );
    }
    // 取得失敗 or 0件: 番号を直接手入力できるフォールバック。
    if (issuesState === "error" || issues.length === 0) {
      return (
        <div className="github-pane-field">
          <span className="github-pane-label">issue/PR番号(任意)</span>
          <input
            type="text"
            className="github-pane-input"
            placeholder="42"
            value={issueRef}
            disabled={submitting}
            onChange={(e) => setIssueRef(e.target.value)}
          />
          <span className="github-pane-hint">
            {issuesState === "error"
              ? "一覧を取得できませんでした。番号を直接入力できます"
              : "open な issue/PR はありません。番号を直接入力できます"}
          </span>
        </div>
      );
    }
    // 取得成功: プルダウン。
    return (
      <div className="github-pane-field">
        <span className="github-pane-label">issue/PR(任意)</span>
        <select
          className="github-pane-input"
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
    <div className="github-pane-form">
      {reposState === "loading" && (
        <span className="github-pane-hint">リポジトリ一覧を読み込み中…</span>
      )}
      {reposState === "error" && (
        <span className="github-pane-hint">
          リポジトリ一覧を取得できませんでした。org / repo は手入力してください
        </span>
      )}

      {usePulldown ? (
        <>
          <div className="github-pane-field">
            <span className="github-pane-label">org</span>
            <select
              className="github-pane-input"
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
          <div className="github-pane-field">
            <span className="github-pane-label">repo</span>
            <select
              className="github-pane-input"
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
        </>
      ) : (
        <>
          <div className="github-pane-field">
            <span className="github-pane-label">org</span>
            <input
              type="text"
              className="github-pane-input"
              list="github-pane-org-candidates"
              placeholder="owner"
              value={org}
              disabled={submitting}
              onChange={(e) => setOrg(e.target.value)}
            />
            <datalist id="github-pane-org-candidates">
              {orgCandidates.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
          </div>
          <div className="github-pane-field">
            <span className="github-pane-label">repo</span>
            <input
              type="text"
              className="github-pane-input"
              list="github-pane-repo-candidates"
              placeholder="repo"
              value={repo}
              disabled={submitting}
              onChange={(e) => setRepo(e.target.value)}
            />
            <datalist id="github-pane-repo-candidates">
              {repoCandidates.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </div>
        </>
      )}

      {renderIssueField()}

      <div className="github-pane-field">
        <span className="github-pane-label">開始</span>
        <input
          type="datetime-local"
          className="github-pane-input"
          value={startLocal}
          disabled={submitting}
          onChange={(e) => setStartLocal(e.target.value)}
        />
      </div>
      <div className="github-pane-field">
        <span className="github-pane-label">終了</span>
        <input
          type="datetime-local"
          className="github-pane-input"
          value={endLocal}
          disabled={submitting}
          onChange={(e) => setEndLocal(e.target.value)}
        />
      </div>

      <div className="github-pane-field">
        <span className="github-pane-label">agent(任意、既定は manual)</span>
        <input
          type="text"
          className="github-pane-input"
          placeholder="manual"
          value={agent}
          disabled={submitting}
          onChange={(e) => setAgent(e.target.value)}
        />
      </div>

      <div className="github-pane-submit-row">
        <button
          type="button"
          className="github-pane-save-btn"
          disabled={submitting}
          onClick={handleSave}
        >
          {submitting ? "追加中…" : "実績を追加"}
        </button>
        {error && <span className="github-pane-error">{error}</span>}
      </div>
    </div>
  );
}

interface WorkLogHistoryProps {
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
function WorkLogHistory({
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
            <span className="github-pane-group-latest">{formatWorkLogDate(group.latestStartMs)}</span>
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
 * 編集の保存・削除は非楽観更新 — onUpdate/onDelete 成功後に App.tsx が work-logs を再取得する
 * (成功時は本行が新しいリストで置き換わるため、ここで view へ戻す必要は無い)。
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
        {formatWorkLogRange(log.startMs, log.endMs)}(
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

/** epoch ms のペアを "M/D H:mm–H:mm" 形式で表示する(TimeReportOverlay と同じ簡易フォーマット、
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
