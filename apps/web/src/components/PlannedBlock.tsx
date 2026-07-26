import { useEffect, useRef } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { PlannedBlock } from "../model/types";
import { formatRange, pxToMinutes } from "../layout/gridMetrics";
import { computeMovedRange, computeResizedEndMs } from "../sync/planned";
import { msToTopPx } from "../layout/gridMetrics";
import { useHourHeight } from "../hooks/useHourHeight";
import {
  SELECTED_CARD_CLASS,
  shouldBeginCardDrag,
  TAP_SELECT_CARD_CLASS,
} from "../layout/swipeNav";
import "./PlannedBlock.css";
import "./EventSelection.css";

interface PlannedBlockCardProps {
  block: PlannedBlock;
  /** このカードが今属している日の 0:00 (epoch ms)。移動ドラッグの着地計算に使う */
  dayStartMs: number;
  /** その日の 0:00 からの px オフセット(親が計算済み、layout/gridMetrics.ts の msToTopPx) */
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
  /**
   * スマホの操作体系(2026-07-26、ユーザー要望): true のとき「タップで選択 → 選択中だけ
   * ドラッグで移動/リサイズ」に切り替える(EventBlock と全く同じ考え方に揃える)。
   * false(デスクトップ)では従来どおり pointerdown で即ドラッグが始まる。
   */
  selectBeforeDrag?: boolean;
  /** このカードが選択中か(WeekGrid の selectedCardId と一致するか) */
  isSelected?: boolean;
  /** タップ(移動を伴わない pointerup)でこのカードを選択状態にする */
  onSelect?: () => void;
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
  selectBeforeDrag = false,
  isSelected = false,
  onSelect,
}: PlannedBlockCardProps) {
  // 時間軸ズーム(2026-07-25): ドラッグ中の px⇔分 変換に使う現在のズーム値
  // (top/height 自体は親 DayColumn が同じ値で計算済み)
  const hourHeight = useHourHeight();
  const elRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  /**
   * 「タップで選択」待ちの状態(EventBlock.tsx の tapRef と同じ役割・同じ理由)。
   * ドラッグを始めない = 何も掴まないので、この pointerdown は .week-grid の横スワイプ
   * (日移動)へそのまま流れる。移動を伴わない pointerup だけを拾って選択に繋げる。
   */
  const tapRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);

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

  /** スマホの「未選択カードはドラッグを始めず、横スワイプに通す」判定(layout/swipeNav.ts) */
  function canBeginDrag(e: ReactPointerEvent<HTMLDivElement>): boolean {
    return shouldBeginCardDrag({ pointerType: e.pointerType, selectBeforeDrag, isSelected });
  }

  function handlePointerDownMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!canBeginDrag(e)) {
      if (e.button !== 0) return;
      tapRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
      return;
    }
    tapRef.current = null;
    beginDrag(e, "move");
  }

  function handlePointerDownResize(e: ReactPointerEvent<HTMLDivElement>) {
    // 未選択カード(スマホ)では stopPropagation もしない ―― 親のタップ判定と
    // .week-grid のスワイプへ通すため(EventBlock.tsx と同じ)
    if (!canBeginDrag(e)) return;
    e.stopPropagation();
    beginDrag(e, "resize");
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const tap = tapRef.current;
    if (tap && tap.pointerId === e.pointerId) {
      if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) >= CLICK_THRESHOLD_PX) {
        tapRef.current = null;
      }
    }

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
      const rawStartMs = ds.originalStartMs + pxToMinutes(dy, hourHeight) * 60_000;
      const durationMs = ds.originalEndMs - ds.originalStartMs;
      const { startMs, endMs } = computeMovedRange(
        rawStartMs,
        ds.originalStartMs,
        durationMs,
        e.altKey,
      );
      const newTopPx = msToTopPx(startMs, ds.dayStartMs, hourHeight);
      el.style.transform = `translateY(${newTopPx - ds.originalTopPx}px)`;
      ds.pendingStartMs = startMs;
      ds.pendingEndMs = endMs;
      ds.badgeEl.textContent = formatRange(startMs, endMs, timeZone);
    } else {
      const rawEndMs = ds.originalEndMs + pxToMinutes(dy, hourHeight) * 60_000;
      const endMs = computeResizedEndMs(rawEndMs, ds.originalStartMs, ds.originalStartMs, e.altKey);
      const newHeightPx = Math.max(
        msToTopPx(endMs, ds.dayStartMs, hourHeight) - ds.originalTopPx,
        4,
      );
      el.style.height = `${newHeightPx}px`;
      ds.pendingEndMs = endMs;
      ds.badgeEl.textContent = formatRange(ds.originalStartMs, endMs, timeZone);
    }

    ds.badgeEl.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    // スマホの未選択カード: 移動を伴わない pointerup = タップ → 選択(以後ドラッグで移動できる)。
    // 予定タイムブロックには詳細ポップオーバーが無いので、選択だけを行う。
    const tap = tapRef.current;
    if (tap && tap.pointerId === e.pointerId) {
      tapRef.current = null;
      onSelect?.();
      return;
    }

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
    if (tapRef.current?.pointerId === e.pointerId) tapRef.current = null;
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
      className={[
        "planned-block",
        `planned-block--${block.itemType}`,
        isTimerRunning ? "planned-block--timer-running" : "",
        // スマホの「タップで選択 → ドラッグで移動」(2026-07-26、EventBlock.tsx と同じ印)
        selectBeforeDrag ? TAP_SELECT_CARD_CLASS : "",
        selectBeforeDrag && isSelected ? SELECTED_CARD_CLASS : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-selected={selectBeforeDrag ? isSelected : undefined}
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
