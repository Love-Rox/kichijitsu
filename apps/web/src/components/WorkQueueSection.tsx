import type { DragEvent as ReactDragEvent } from "react";
import type { GitHubWorkItemDTO } from "@kichijitsu/shared";
import { groupWorkItemsByKind } from "../sync/workQueue";
import { WORKITEM_DND_MIME } from "../sync/planned";
import type { TimerLinkedItem } from "../sync/timeTracking";
import { PaneSection } from "./PaneSection";

/**
 * 作業キューセクション(docs/github-integration.md フェーズ②Part B)。2026-07-25 のファイル分割
 * (リファクタ フェーズ1b)で GitHubPane.tsx から切り出した ―― props の形・クラス名・挙動は無変更。
 * CSS(GitHubPane.css)の import は GitHubPane.tsx 側の1箇所のまま(PaneSection.tsx のコメント参照)。
 */
export interface WorkQueueSectionProps {
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
 * セクション固有のデータ操作である更新ボタン(onRefresh)は、アコーディオンのトグルとは別の
 * ボタンとして見出し行の右端に置く(PaneSection の action)。
 *
 * 2026-07-25 の実績モーダル吸収で各行に ▶(計測開始)を足した ―― 旧 WorkLogModal の
 * TimerQueueRow が持っていた導線。グリッドへのドラッグ予定化は従来どおり維持している
 * (WorkQueueItemRow のコメント参照)。
 */
export function WorkQueueSection({
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
