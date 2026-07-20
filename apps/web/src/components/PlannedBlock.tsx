import { useEffect, useRef } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { PlannedBlock } from "../model/types";
import { formatRange, pxToMinutes } from "../layout/gridMetrics";
import { computeMovedRange, computeResizedEndMs, plannedBlockTopPx } from "../sync/planned";

interface PlannedBlockCardProps {
  block: PlannedBlock;
  /** このカードが今属している日の 0:00 (epoch ms)。移動ドラッグの着地計算に使う */
  dayStartMs: number;
  /** その日の 0:00 からの px オフセット(親が計算済み、sync/planned.ts の plannedBlockTopPx) */
  top: number;
  height: number;
  leftPct: number;
  widthPct: number;
  timeZone: string;
  /**
   * 移動/リサイズドラッグの確定時に呼ばれる(ローカルのみ、Google 書き込み無し)。
   * App.tsx の onMovePlannedBlock が plannedStore.upsert + IndexedDB 書き込みだけを行う。
   */
  onMove: (id: string, startMs: number, endMs: number) => void;
  /** 削除ボタンから呼ばれる(ローカルのみ) */
  onDelete: (id: string) => void;
  /**
   * 手動タイマー(docs/github-integration.md「時間計測」増分2)。この block の linkedItemId が
   * 走行中かどうか(App 側の timeEntryStore.isRunning)。true なら ⏹、false なら ▶ を出す。
   * 他 item が走行中でも ▶ は常に押せる(単一走行の制約は無い、複数併走可)。
   */
  isTimerRunning: boolean;
  /** ▶ ボタンから呼ばれる(ローカルのみ)。この block をそのまま渡す(linkedItemId 等を含む) */
  onStartTimer: (block: PlannedBlock) => void;
  /** ⏹ ボタンから呼ばれる(ローカルのみ)。この block の linkedItemId のタイマーだけを止める */
  onStopTimer: (linkedItemId: string) => void;
}

interface DragState {
  kind: "move" | "resize";
  pointerId: number;
  moved: boolean;
  startClientY: number;
  startClientX: number;
  dayStartMs: number;
  originalStartMs: number;
  originalEndMs: number;
  originalTopPx: number;
  originalHeightPx: number;
  pendingStartMs: number;
  pendingEndMs: number;
  badgeEl: HTMLDivElement;
}

const CLICK_THRESHOLD_PX = 4;

/**
 * 予定タイムブロック(docs/github-integration.md「時間計測」増分1)の1枚のカード。
 * EventBlock.tsx の move/resize ドラッグと同じ「pointermove 中は React state を
 * 更新せず DOM に直接書き込み、pointerup で確定した瞬間だけコールバックを呼ぶ」規律を
 * 踏襲するが、cross-day 移動は対象外(この増分は同一日内の移動/リサイズ/削除のみ)。
 * 確定コールバック (onMove/onDelete) は常にローカルのみ — Google への書き戻しは無い。
 */
export function PlannedBlockCard({
  block,
  dayStartMs,
  top,
  height,
  leftPct,
  widthPct,
  timeZone,
  onMove,
  onDelete,
  isTimerRunning,
  onStartTimer,
  onStopTimer,
}: PlannedBlockCardProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  // アンマウント時にドラッグ中なら後始末(バッジの残留防止、EventBlock と同じ流儀)
  useEffect(() => {
    return () => {
      const ds = dragRef.current;
      if (!ds) return;
      ds.badgeEl.remove();
      dragRef.current = null;
    };
  }, []);

  function createBadge(): HTMLDivElement {
    const badge = document.createElement("div");
    badge.className = "drag-badge";
    return badge;
  }

  function beginDrag(e: ReactPointerEvent<HTMLDivElement>, kind: DragState["kind"]) {
    if (e.button !== 0) return;
    const el = elRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    dragRef.current = {
      kind,
      pointerId: e.pointerId,
      moved: false,
      startClientY: e.clientY,
      startClientX: e.clientX,
      dayStartMs,
      originalStartMs: block.startMs,
      originalEndMs: block.endMs,
      originalTopPx: top,
      originalHeightPx: height,
      pendingStartMs: block.startMs,
      pendingEndMs: block.endMs,
      badgeEl: createBadge(),
    };
  }

  function handlePointerDownMove(e: ReactPointerEvent<HTMLDivElement>) {
    beginDrag(e, "move");
  }

  function handlePointerDownResize(e: ReactPointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    beginDrag(e, "resize");
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const ds = dragRef.current;
    const el = elRef.current;
    if (!ds || !el || ds.pointerId !== e.pointerId) return;

    const dx = e.clientX - ds.startClientX;
    const dy = e.clientY - ds.startClientY;
    if (!ds.moved && Math.hypot(dx, dy) >= CLICK_THRESHOLD_PX) {
      ds.moved = true;
      el.classList.add("planned-block--dragging");
      document.body.appendChild(ds.badgeEl);
    }
    if (!ds.moved) return;

    if (ds.kind === "move") {
      const rawStartMs = ds.originalStartMs + pxToMinutes(dy) * 60_000;
      const durationMs = ds.originalEndMs - ds.originalStartMs;
      const { startMs, endMs } = computeMovedRange(
        rawStartMs,
        ds.originalStartMs,
        durationMs,
        e.altKey,
      );
      const newTopPx = plannedBlockTopPx(startMs, ds.dayStartMs);
      el.style.transform = `translateY(${newTopPx - ds.originalTopPx}px)`;
      ds.pendingStartMs = startMs;
      ds.pendingEndMs = endMs;
      ds.badgeEl.textContent = formatRange(startMs, endMs, timeZone);
    } else {
      const rawEndMs = ds.originalEndMs + pxToMinutes(dy) * 60_000;
      const endMs = computeResizedEndMs(rawEndMs, ds.originalStartMs, ds.originalStartMs, e.altKey);
      const newHeightPx = Math.max(plannedBlockTopPx(endMs, ds.dayStartMs) - ds.originalTopPx, 4);
      el.style.height = `${newHeightPx}px`;
      ds.pendingEndMs = endMs;
      ds.badgeEl.textContent = formatRange(ds.originalStartMs, endMs, timeZone);
    }

    ds.badgeEl.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const ds = dragRef.current;
    const el = elRef.current;
    if (!ds || !el || ds.pointerId !== e.pointerId) return;
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      /* すでに解放済みなら無視 */
    }
    ds.badgeEl.remove();

    if (!ds.moved) {
      dragRef.current = null;
      return;
    }

    el.classList.remove("planned-block--dragging");
    el.style.transform = "";
    // height はここでリセットしない: onMove() が plannedStore.upsert を経て親を再レンダーさせ、
    // 確定後の height prop がそのまま反映される(EventBlock.tsx の resize 確定と同じ流儀)
    dragRef.current = null;

    if (ds.kind === "move") {
      onMove(block.id, ds.pendingStartMs, ds.pendingEndMs);
    } else {
      onMove(block.id, ds.originalStartMs, ds.pendingEndMs);
    }
  }

  function handlePointerCancel(e: ReactPointerEvent<HTMLDivElement>) {
    const ds = dragRef.current;
    const el = elRef.current;
    if (!ds || !el || ds.pointerId !== e.pointerId) return;
    ds.badgeEl.remove();
    el.classList.remove("planned-block--dragging");
    el.style.transform = "";
    if (ds.kind === "resize") el.style.height = `${ds.originalHeightPx}px`;
    dragRef.current = null;
  }

  // リサイズ中は height への React 再レンダーの上書きを止める(EventBlock.tsx と同じガード)。
  // WeekGrid は「現在時刻線」用に nowMs を1分ごと更新するため、ドラッグ中に親が再レンダーされる
  // ことがある — その際に手動で書き込んだ el.style.height を巻き戻されないようにするため
  const isResizing = dragRef.current?.kind === "resize";
  const style: CSSProperties = {
    top,
    left: `calc(3px + (100% - 6px) * ${leftPct / 100})`,
    width: `calc((100% - 6px) * ${widthPct / 100})`,
  };
  if (!isResizing) {
    style.height = height;
  }

  return (
    <div
      ref={elRef}
      className={
        isTimerRunning
          ? `planned-block planned-block--${block.itemType} planned-block--timer-running`
          : `planned-block planned-block--${block.itemType}`
      }
      style={style}
      onPointerDown={handlePointerDownMove}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      title={`${block.repo} #${block.number} ${block.title}`}
    >
      <button
        type="button"
        className="planned-block-delete"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onDelete(block.id);
        }}
        aria-label="予定を削除"
        title="削除"
      >
        ×
      </button>
      {/*
       * 手動タイマー(増分2)の ▶/⏹。delete ボタンと同じ「小さなヒット領域 + stopPropagation」の
       * 扱いにして、ドラッグ移動/リサイズ/リンククリックと競合しないようにする。
       */}
      <button
        type="button"
        className={isTimerRunning ? "planned-block-timer is-running" : "planned-block-timer"}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          if (isTimerRunning) {
            onStopTimer(block.linkedItemId);
          } else {
            onStartTimer(block);
          }
        }}
        aria-label={isTimerRunning ? "タイマーを停止" : "タイマーを開始"}
        title={isTimerRunning ? "計測を停止" : "計測を開始"}
      >
        {isTimerRunning ? "⏹" : "▶"}
      </button>
      <a
        className="planned-block-link"
        href={block.url}
        target="_blank"
        rel="noopener noreferrer"
        onPointerDown={(e) => e.stopPropagation()}
      >
        #{block.number}
      </a>
      <span className="planned-block-title">{block.title}</span>
      <span className="planned-block-repo">{block.repo}</span>
      <div className="planned-block-resize-handle" onPointerDown={handlePointerDownResize} />
    </div>
  );
}
