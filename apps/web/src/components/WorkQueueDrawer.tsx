import { useRef } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import type { GitHubWorkItemDTO } from "@kichijitsu/shared";
import { groupWorkItemsByKind } from "../sync/workQueue";
import { WORKITEM_DND_MIME } from "../sync/planned";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import "./WorkQueueDrawer.css";

export interface WorkQueueDrawerProps {
  items: GitHubWorkItemDTO[];
  loading: boolean;
  authExpired: boolean;
  onRefresh: () => void;
  onReconnect: () => void;
  onClose: () => void;
  /**
   * ドラッグでのタイムブロック化(docs/github-integration.md「時間計測」増分1)開始時に
   * 呼ばれる。このドロワーは fixed オーバーレイ(z-index 2000, 全画面 inset:0 の
   * backdrop)でグリッドの上に被さっているため、開いたままだとグリッドへドロップできない
   * ―― App.tsx はこれを受けてドロワーを閉じる(仕様どおり「ドラッグ中は閉じてよい」)。
   * dataTransfer への setData は dragstart 同期実行内で完了済みなので、直後にこの
   * コンポーネントがアンマウントされてもドラッグ操作自体はブラウザ側で継続する。
   */
  onDragStart: () => void;
}

/**
 * 作業キュー サイドレール(docs/github-integration.md フェーズ②Part B)。
 * SearchOverlay/BlockRulesOverlay と同じ役割分担 — App.tsx が開閉制御し、このコンポーネントは
 * 常に「開いている」前提でマウントされる(閉じたらアンマウント、次に開くと新規状態で始まる)。
 * ただし見せ方は中央モーダルではなく右からスライドインする常設サイドレール
 * (全幅グリッドをリフローさせない fixed オーバーレイ、CSS 参照)。
 *
 * items は React state のみで保持(IndexedDB には入れない、docs 方針)。ここでは
 * groupWorkItemsByKind (sync/workQueue.ts) で3セクションへ振り分けて描画するだけでなく、
 * 各行をグリッドへドラッグしてタイムブロック化できる(docs/github-integration.md
 * 「時間計測」増分1、2026-07-20、WorkQueueItemRow 参照)。
 */
export function WorkQueueDrawer({
  items,
  loading,
  authExpired,
  onRefresh,
  onReconnect,
  onClose,
  onDragStart,
}: WorkQueueDrawerProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  useCloseOnOutsideOrEscape(true, cardRef, onClose);

  const sections = groupWorkItemsByKind(items);
  const isEmpty = items.length === 0;
  // 初回ロード(まだ何も持っていない)だけスケルトンを出す。onRefresh での再取得中は
  // 直前のリストを表示したまま(更新ボタン側の「…」表示だけで進行を伝える)
  const showSkeleton = loading && isEmpty;

  return (
    <div className="work-queue-drawer-backdrop">
      <div className="work-queue-drawer" ref={cardRef} role="dialog" aria-label="作業キュー">
        <div className="work-queue-drawer-header">
          <span className="work-queue-drawer-title">作業キュー</span>
          <div className="work-queue-drawer-actions">
            <button
              type="button"
              className="work-queue-refresh-btn"
              onClick={onRefresh}
              disabled={loading}
              aria-label="作業キューを更新"
              title="更新"
            >
              {loading ? "…" : "⟳"}
            </button>
            <button
              type="button"
              className="work-queue-close-btn"
              onClick={onClose}
              aria-label="閉じる"
            >
              ×
            </button>
          </div>
        </div>

        {authExpired && (
          <div className="work-queue-auth-expired">
            <p>GitHub の認可が切れました。</p>
            <button type="button" className="work-queue-reconnect-btn" onClick={onReconnect}>
              再連携
            </button>
          </div>
        )}

        <div className="work-queue-body">
          {showSkeleton ? (
            <WorkQueueSkeleton />
          ) : isEmpty ? (
            authExpired ? null : (
              <p className="work-queue-empty-all">作業キューは空です</p>
            )
          ) : (
            sections.map((section) => (
              <section className="work-queue-section" key={section.kind}>
                <h3 className="work-queue-section-title">{section.label}</h3>
                {section.items.length === 0 ? (
                  <p className="work-queue-section-empty">該当なし</p>
                ) : (
                  <ul className="work-queue-item-list">
                    {section.items.map((item) => (
                      <li key={`${section.kind}:${item.id}`}>
                        <WorkQueueItemRow item={item} onDragStart={onDragStart} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
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
    <div className="work-queue-item-row" draggable onDragStart={handleDragStart}>
      <a
        className={`work-queue-item work-queue-item--${item.type}`}
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`${item.repo} #${item.number} ${item.title}`}
        draggable={false}
      >
        <span className="work-queue-item-kind" aria-hidden="true">
          {item.type === "pr" ? "PR" : "Iss"}
        </span>
        <span className="work-queue-item-main">
          <span className="work-queue-item-title">{item.title}</span>
          <span className="work-queue-item-meta">
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
    <div className="work-queue-skeleton" aria-hidden="true">
      <div className="work-queue-skeleton-line" />
      <div className="work-queue-skeleton-line" />
      <div className="work-queue-skeleton-line work-queue-skeleton-line--short" />
    </div>
  );
}
