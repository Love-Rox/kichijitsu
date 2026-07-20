import { useRef } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import type { GitHubWorkItemDTO } from "@kichijitsu/shared";
import { groupWorkItemsByKind } from "../sync/workQueue";
import { WORKITEM_DND_MIME } from "../sync/planned";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import type { PaneMode } from "../layout/paneMode";
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
              <span aria-hidden="true">{isOverlay ? "📌" : "⧉"}</span>
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
        {/*
         * 将来拡張の布石(今回は実装しない、docs/github-integration.md 参照):
         *   - 実績サマリ/出力セクション
         *   - MCP 取得セクション
         *   - GitHub レーン項目集約セクション
         * 追加時は WorkQueueSection と同じ形("github-pane-section" を返すコンポーネント)で
         * ここに並べて足すか、sections を配列化して map する形に発展させる。
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
