import { useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import type { GitHubWorkItemDTO, WorkLogCreateRequest, WorkLogDTO } from "@kichijitsu/shared";
import type { PlannedBlock, TimeEntry } from "../model/types";
import { groupWorkItemsByKind } from "../sync/workQueue";
import { WORKITEM_DND_MIME } from "../sync/planned";
import { buildReportRows, reportRowsToCsv, type ActualsReportRow } from "../sync/reportExport";
import { formatDurationHm } from "../sync/timeTracking";
import {
  buildWorkLogCreateRequest,
  collectWorkLogOrgCandidates,
  collectWorkLogRepoCandidates,
  combineOrgRepo,
  isManualWorkLog,
  validateWorkLogEntryForm,
  WORK_LOG_ENTRY_ERROR_MESSAGES,
  type WorkLogEntryFormInput,
} from "../sync/workLogEntry";
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
  // 作業キューセクション(増分1で唯一のセクション、docs/github-integration.md フェーズ②Part B)
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
  // 実績セクション(docs/github-integration.md「時間計測」増分2、GitHubPane 増分2)。
  // buildReportRows (sync/reportExport.ts) に必要な4入力をそのまま渡す — App.tsx 側で
  // ペインが開いていて GitHub 連携済みのときに取得したデータ(TimeReportOverlay と同じ
  // reportWorkLogs/prCommitEstimates を再利用、二重取得はしない)。
  reportPlannedBlocks: PlannedBlock[];
  reportTimeEntries: TimeEntry[];
  reportWorkLogs: WorkLogDTO[];
  prCommitEstimatesByKey: Record<string, number>;
  /** レポート集計の「現在時刻」(走行中タイマーの経過を含めるため)。App.tsx の timerNowMs をそのまま渡す */
  nowMs: number;
  /** 詳細レポート(TimeReportOverlay)を開くボタンから呼ばれる */
  onOpenDetailReport: () => void;
  // 実績の手動記録セクション(ManualWorkLogSection、2026-07-22)。TimeReportOverlay にあった手動追加
  // フォームを、リポジトリ紐付けが自然な右ペインへ集約した。datetime-local の解釈に使うアプリ設定の
  // タイムゾーンと、書き込み/削除ハンドラ(App.tsx の handleCreateWorkLog/handleDeleteWorkLog、
  // 成功後に work-logs を再取得する非楽観更新)をそのまま渡す。
  /** datetime-local の入力をアプリ設定のタイムゾーンのローカル壁時計として解釈するために使う */
  timeZone: string;
  /** 実績を手動で追加する。成功/失敗は呼び出し側(App.tsx)が work-logs を再取得して反映する */
  onCreateWorkLog: (req: WorkLogCreateRequest) => Promise<void>;
  /** 手動エントリ(agent: manual)を削除する。isManualWorkLog な行にだけ削除ボタンを出す */
  onDeleteWorkLog: (id: string) => Promise<void>;
}

/**
 * GitHub 情報ペイン(docs/github-integration.md フェーズ②Part B → 増分1でセクション式
 * コンテナへ発展)。旧 WorkQueueDrawer を置き換える — 増分1では「作業キュー」の1セクションのみ
 * だが、将来セクションを追加できるよう container(このコンポーネント)/section
 * (WorkQueueSection のようなセクション単位のコンポーネント)の2層構造にしてある
 * (github-pane-body 内の TODO コメント参照)。ペイン自身の見出しは「GitHub」に一般化し、
 * 「作業キュー」という文言は WorkQueueSection 自身のセクション見出しへ移した
 * (更新ボタンもセクション固有のデータ操作のためセクション側へ)。
 *
 * overlay/docked の2つの配置モードを持つ(PaneMode、layout/paneMode.ts):
 *   - overlay: 従来通り fixed backdrop + 右からスライドインする常設サイドレール。
 *     外側クリック・Escape で閉じる。
 *   - docked: グリッドの右に常設する flex サイドバー(position: fixed を使わず、通常の
 *     flex アイテムとしてレイアウトに参加しグリッド側を flex-shrink させる)。
 *     常設が主旨のため外側クリック・Escape では閉じない(明示的な閉じるボタンのみ)。
 *
 * items は React state のみで保持(IndexedDB には入れない、docs 方針)。ここでは
 * groupWorkItemsByKind (sync/workQueue.ts) で3グループへ振り分けて描画するだけでなく、
 * 各行をグリッドへドラッグしてタイムブロック化できる(docs/github-integration.md
 * 「時間計測」増分1、WorkQueueItemRow 参照)。
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
  reportPlannedBlocks,
  reportTimeEntries,
  reportWorkLogs,
  prCommitEstimatesByKey,
  nowMs,
  onOpenDetailReport,
  timeZone,
  onCreateWorkLog,
  onDeleteWorkLog,
}: GitHubPaneProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const isOverlay = mode === "overlay";
  // docked(常設)は外側クリック・Escape では閉じない — active=false でリスナー自体を張らない
  useCloseOnOutsideOrEscape(isOverlay, cardRef, onClose);

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
        <WorkQueueSection
          items={items}
          loading={loading}
          authExpired={authExpired}
          onRefresh={onRefresh}
          onReconnect={onReconnect}
          onDragStart={onDragStart}
        />
        <ActualsSection
          plannedBlocks={reportPlannedBlocks}
          timeEntries={reportTimeEntries}
          workLogs={reportWorkLogs}
          estimatesByKey={prCommitEstimatesByKey}
          nowMs={nowMs}
          onOpenDetailReport={onOpenDetailReport}
        />
        <ManualWorkLogSection
          plannedBlocks={reportPlannedBlocks}
          workLogs={reportWorkLogs}
          timeZone={timeZone}
          onCreate={onCreateWorkLog}
          onDelete={onDeleteWorkLog}
        />
        {/*
         * 将来拡張の布石(今回は実装しない、docs/github-integration.md 参照):
         *   - MCP 取得セクション(D1 の work-log 側 MCP ツール経由での実績取得。ここでは
         *     App.tsx が GET /api/work-logs で取得したものをそのまま使っているのみ)
         *   - GitHub レーン項目集約セクション
         * 追加時は WorkQueueSection/ActualsSection と同じ形("github-pane-section" を返す
         * コンポーネント)でここに並べて足すか、sections を配列化して map する形に発展させる。
         */}
      </div>
    </div>
  );

  if (isOverlay) {
    return <div className="github-pane-backdrop">{paneRoot}</div>;
  }
  return paneRoot;
}

interface WorkQueueSectionProps {
  items: GitHubWorkItemDTO[];
  loading: boolean;
  authExpired: boolean;
  onRefresh: () => void;
  onReconnect: () => void;
  onDragStart: () => void;
}

/**
 * 作業キューセクション(増分1で GitHubPane 唯一のセクション、docs/github-integration.md
 * フェーズ②Part B)。旧 WorkQueueDrawer のダイアログ見出し(タイトル・更新/閉じるボタン)は
 * ペイン側の共通見出し(github-pane-header)に一本化されたため、このコンポーネントは
 * 「作業キュー」というセクション固有の見出し行(タイトル+更新ボタン)を自前で持つ ——
 * データの更新(onRefresh)はこのセクションのデータソース固有の操作であり、
 * ペイン全体の開閉とは独立しているため。
 */
function WorkQueueSection({
  items,
  loading,
  authExpired,
  onRefresh,
  onReconnect,
  onDragStart,
}: WorkQueueSectionProps) {
  const sections = groupWorkItemsByKind(items);
  const isEmpty = items.length === 0;
  // 初回ロード(まだ何も持っていない)だけスケルトンを出す。onRefresh での再取得中は
  // 直前のリストを表示したまま(更新ボタン側の「…」表示だけで進行を伝える)
  const showSkeleton = loading && isEmpty;

  return (
    <section className="github-pane-section">
      <div className="github-pane-section-header">
        <h3 className="github-pane-section-title">作業キュー</h3>
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
      </div>

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
          <p className="github-pane-empty-all">作業キューは空です</p>
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
                    <WorkQueueItemRow item={item} onDragStart={onDragStart} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))
      )}
    </section>
  );
}

interface WorkQueueItemRowProps {
  item: GitHubWorkItemDTO;
  onDragStart: () => void;
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
 */
function WorkQueueItemRow({ item, onDragStart }: WorkQueueItemRowProps) {
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

interface ActualsSectionProps {
  plannedBlocks: PlannedBlock[];
  timeEntries: TimeEntry[];
  workLogs: WorkLogDTO[];
  estimatesByKey: Record<string, number>;
  nowMs: number;
  onOpenDetailReport: () => void;
}

const REPORT_CSV_FILENAME = "kichijitsu-report.csv";

/**
 * 実績セクション(docs/github-integration.md「時間計測」増分2 Part B、GitHubPane 増分2)。
 * sync/reportExport.ts の buildReportRows で「予定/実績(手動)/実績(hook)/推定」を1行に
 * マージし、ペインの幅に収まるコンパクトな表で見渡せるようにする。詳細な内訳(比率バー等)は
 * 従来通り TimeReportOverlay(「詳細を開く」ボタン)に譲る — このセクションはサマリ+出力の役割。
 *
 * workLogs/estimatesByKey は App.tsx がペイン可視時に取得する(TimeReportOverlay と同じ
 * state を再利用、専用の取得は行わない)。取得前・取得失敗時は空のまま渡ってくる想定で、
 * その場合は該当行の hookActualMs/estimateMs が undefined になり「—」表示になるだけで
 * 予定/実績(手動)自体の表示は成立する(呼び出し側の App.tsx コメント参照)。
 */
function ActualsSection({
  plannedBlocks,
  timeEntries,
  workLogs,
  estimatesByKey,
  nowMs,
  onOpenDetailReport,
}: ActualsSectionProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const rows = buildReportRows({ plannedBlocks, timeEntries, workLogs, estimatesByKey }, nowMs);

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
    <section className="github-pane-section">
      <div className="github-pane-section-header">
        <h3 className="github-pane-section-title">実績</h3>
        <div className="github-pane-actuals-actions">
          <button
            type="button"
            className="github-pane-actuals-btn"
            onClick={handleDownloadCsv}
            disabled={rows.length === 0}
          >
            CSV
          </button>
          <button
            type="button"
            className="github-pane-actuals-btn"
            onClick={handleCopyCsv}
            disabled={rows.length === 0}
          >
            {copyState === "copied" ? "コピー済み" : copyState === "failed" ? "失敗" : "コピー"}
          </button>
          <button type="button" className="github-pane-actuals-btn" onClick={onOpenDetailReport}>
            詳細
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="github-pane-empty-all">まだ予定・実績がありません</p>
      ) : (
        <div className="github-pane-actuals-table-wrap">
          <table className="github-pane-actuals-table">
            <thead>
              <tr>
                <th>アイテム</th>
                <th>予定</th>
                <th>実績</th>
                <th>hook</th>
                <th>推定</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ActualsRow key={row.linkedItemId} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ActualsRow({ row }: { row: ActualsReportRow }) {
  return (
    <tr>
      <td className="github-pane-actuals-item">
        <a
          href={row.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`${row.repo} #${row.number} ${row.title}`}
        >
          #{row.number} {row.title}
        </a>
      </td>
      <td className="github-pane-actuals-num">{formatDurationHm(row.plannedMs)}</td>
      <td className="github-pane-actuals-num">{formatDurationHm(row.actualMs)}</td>
      <td className="github-pane-actuals-num">
        {row.hookActualMs === undefined ? "—" : formatDurationHm(row.hookActualMs)}
      </td>
      <td className="github-pane-actuals-num">
        {row.estimateMs === undefined ? "—" : `≈${formatDurationHm(row.estimateMs)}`}
      </td>
    </tr>
  );
}

interface ManualWorkLogSectionProps {
  plannedBlocks: PlannedBlock[];
  workLogs: WorkLogDTO[];
  timeZone: string;
  onCreate: (req: WorkLogCreateRequest) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

/** 直近の手動エントリを何件まで出すか(全件の一覧は TimeReportOverlay の「実績ログ」に任せる) */
const RECENT_MANUAL_LIMIT = 5;

/**
 * 実績の手動記録セクション(GitHubPane 増分3、2026-07-22)。従来 TimeReportOverlay にあった
 * 「実績を手動で追加」フォームを、リポジトリ紐付けが自然な右ペインへ移設・集約したもの。
 * サーバーの WorkLogCreateRequest は repo 1フィールドのみだが、UI では org / repo を別入力にして
 * サジェスト(datalist)を効かせやすくし、送信時に combineOrgRepo で "org/repo" へ結合する
 * (送信ボディの形は変えない、workLogEntry.ts のコメント参照)。フォームの下に直近の手動エントリを
 * 数件だけ出して、記録直後に消せる導線(削除ボタン)を用意する — hook 記録には削除ボタンを出さない
 * (isManualWorkLog、TimeReportOverlay と同じ方針)。全件の一覧・削除は引き続き詳細レポート側にある。
 */
function ManualWorkLogSection({
  plannedBlocks,
  workLogs,
  timeZone,
  onCreate,
  onDelete,
}: ManualWorkLogSectionProps) {
  const [org, setOrg] = useState("");
  const [repo, setRepo] = useState("");
  const [issueRef, setIssueRef] = useState("");
  const [startLocal, setStartLocal] = useState("");
  const [endLocal, setEndLocal] = useState("");
  const [agent, setAgent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repoCandidates = collectWorkLogRepoCandidates(workLogs, plannedBlocks);
  const orgCandidates = collectWorkLogOrgCandidates(workLogs, plannedBlocks);

  const recentManual = [...workLogs]
    .filter(isManualWorkLog)
    .sort((a, b) => b.startMs - a.startMs)
    .slice(0, RECENT_MANUAL_LIMIT);

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
    <section className="github-pane-section">
      <div className="github-pane-section-header">
        <h3 className="github-pane-section-title">実績を手動で記録</h3>
      </div>

      <div className="github-pane-worklog-form">
        <div className="github-pane-worklog-field-row">
          <div className="github-pane-worklog-field">
            <span className="github-pane-worklog-label">org</span>
            <input
              type="text"
              className="github-pane-worklog-input"
              list="github-pane-worklog-org-candidates"
              placeholder="owner"
              value={org}
              disabled={submitting}
              onChange={(e) => setOrg(e.target.value)}
            />
            <datalist id="github-pane-worklog-org-candidates">
              {orgCandidates.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
          </div>
          <div className="github-pane-worklog-field">
            <span className="github-pane-worklog-label">repo</span>
            <input
              type="text"
              className="github-pane-worklog-input"
              list="github-pane-worklog-repo-candidates"
              placeholder="repo"
              value={repo}
              disabled={submitting}
              onChange={(e) => setRepo(e.target.value)}
            />
            <datalist id="github-pane-worklog-repo-candidates">
              {repoCandidates.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </div>
        </div>

        <div className="github-pane-worklog-field">
          <span className="github-pane-worklog-label">issue/PR番号(任意)</span>
          <input
            type="text"
            className="github-pane-worklog-input"
            placeholder="42"
            value={issueRef}
            disabled={submitting}
            onChange={(e) => setIssueRef(e.target.value)}
          />
        </div>

        <div className="github-pane-worklog-field-row">
          <div className="github-pane-worklog-field">
            <span className="github-pane-worklog-label">開始</span>
            <input
              type="datetime-local"
              className="github-pane-worklog-input"
              value={startLocal}
              disabled={submitting}
              onChange={(e) => setStartLocal(e.target.value)}
            />
          </div>
          <div className="github-pane-worklog-field">
            <span className="github-pane-worklog-label">終了</span>
            <input
              type="datetime-local"
              className="github-pane-worklog-input"
              value={endLocal}
              disabled={submitting}
              onChange={(e) => setEndLocal(e.target.value)}
            />
          </div>
        </div>

        <div className="github-pane-worklog-field">
          <span className="github-pane-worklog-label">agent(任意、既定は manual)</span>
          <input
            type="text"
            className="github-pane-worklog-input"
            placeholder="manual"
            value={agent}
            disabled={submitting}
            onChange={(e) => setAgent(e.target.value)}
          />
        </div>

        <div className="github-pane-worklog-submit-row">
          <button
            type="button"
            className="github-pane-worklog-save-btn"
            disabled={submitting}
            onClick={handleSave}
          >
            {submitting ? "追加中…" : "実績を追加"}
          </button>
          {error && <span className="github-pane-worklog-error">{error}</span>}
        </div>
      </div>

      {recentManual.length > 0 && (
        <div className="github-pane-worklog-recent">
          <h4 className="github-pane-kind-title">直近の手動記録</h4>
          <RecentManualList logs={recentManual} onDelete={onDelete} />
        </div>
      )}
    </section>
  );
}

interface RecentManualListProps {
  logs: WorkLogDTO[];
  onDelete: (id: string) => Promise<void>;
}

/**
 * 直近の手動エントリ一覧(startMs 降順、上位数件のみ)。各行に訂正用の削除ボタンを出す。
 * ここに来る logs は呼び出し側で isManualWorkLog 済みなので、全行に削除ボタンを付けてよい
 * (hook 記録は含まれない)。行ごとの削除中/失敗表示は TimeReportOverlay の WorkLogList と同じ流儀。
 */
function RecentManualList({ logs, onDelete }: RecentManualListProps) {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);

  return (
    <ul className="github-pane-worklog-list">
      {logs.map((log) => (
        <li className="github-pane-worklog-item" key={log.id}>
          <span className="github-pane-worklog-item-main">
            <span className="github-pane-worklog-item-repo">{log.repo}</span>
            {log.issueRef && (
              <span className="github-pane-worklog-item-issue">#{log.issueRef}</span>
            )}
          </span>
          <span className="github-pane-worklog-item-time">
            {formatWorkLogRange(log.startMs, log.endMs)}(
            {formatDurationHm(Math.max(0, log.endMs - log.startMs))})
          </span>
          <button
            type="button"
            className="github-pane-worklog-delete"
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
          {errorId === log.id && (
            <span className="github-pane-worklog-error">削除に失敗しました</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** epoch ms のペアを "M/D H:mm–H:mm" 形式で表示する(TimeReportOverlay の同名関数と同じ簡易フォーマット、
 * ブラウザのロケール依存を避ける。実績ログは大半が同日内という想定で終了側の日付は省略する)。 */
function formatWorkLogRange(startMs: number, endMs: number): string {
  const start = new Date(startMs);
  const end = new Date(endMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  const datePart = `${start.getMonth() + 1}/${start.getDate()}`;
  const startTime = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
  const endTime = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
  return `${datePart} ${startTime}–${endTime}`;
}
