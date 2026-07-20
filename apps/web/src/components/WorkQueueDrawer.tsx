import { useRef } from "react";
import type { GitHubWorkItemDTO } from "@kichijitsu/shared";
import { groupWorkItemsByKind } from "../sync/workQueue";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import "./WorkQueueDrawer.css";

export interface WorkQueueDrawerProps {
  items: GitHubWorkItemDTO[];
  loading: boolean;
  authExpired: boolean;
  onRefresh: () => void;
  onReconnect: () => void;
  onClose: () => void;
}

/**
 * 作業キュー サイドレール(docs/github-integration.md フェーズ②Part B)。
 * SearchOverlay/BlockRulesOverlay と同じ役割分担 — App.tsx が開閉制御し、このコンポーネントは
 * 常に「開いている」前提でマウントされる(閉じたらアンマウント、次に開くと新規状態で始まる)。
 * ただし見せ方は中央モーダルではなく右からスライドインする常設サイドレール
 * (全幅グリッドをリフローさせない fixed オーバーレイ、CSS 参照)。
 *
 * items は React state のみで保持(IndexedDB には入れない、docs 方針)。ここでは
 * groupWorkItemsByKind (sync/workQueue.ts) で3セクションへ振り分けて描画するだけの
 * 表示専用コンポーネント — ドラッグ→タイムブロック化は次フェーズで別途対応する。
 */
export function WorkQueueDrawer({
  items,
  loading,
  authExpired,
  onRefresh,
  onReconnect,
  onClose,
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
                        <WorkQueueItemRow item={item} />
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
}

/**
 * 作業キュー1行。GitHubLane.tsx の item チップと同じ流儀 — <a target="_blank"> で
 * GitHub 側の画面をそのまま新規タブで開く(onClick+window.open ではなくネイティブリンクの
 * 挙動をそのまま活かす)。type バッジの色も GitHubLane と揃える(issue=紫 #6e5494/PR=緑 #0b8043)。
 */
function WorkQueueItemRow({ item }: WorkQueueItemRowProps) {
  return (
    <a
      className={`work-queue-item work-queue-item--${item.type}`}
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${item.repo} #${item.number} ${item.title}`}
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
