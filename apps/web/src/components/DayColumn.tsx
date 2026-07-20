import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Occurrence } from "../model/types";
import type { WriteTargetCandidate } from "../sync/eventCreate";
import { packColumns } from "../layout/packColumns";
import type { OccurrenceGroup } from "../layout/groupDuplicates";
import {
  busyOverlapColors,
  cascadeStepFrac,
  COMPACT_THRESHOLD_MIN,
  isBusyPlaceholder,
  minutesToPx,
  pxToMinutes,
} from "../layout/gridMetrics";
import { resolveDisplayColor } from "../layout/eventColors";
import { snapStartMs, SNAP_MS } from "../layout/snap";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import { EventBlock, type CalendarInfo } from "./EventBlock";

/** 空き領域クリックで作る新規予定のデフォルトの長さ(縦ドラッグせずクリックだけで確定した場合) */
const DEFAULT_CREATE_DURATION_MS = 60 * 60_000;
/** これ未満の移動量はドラッグとみなさず「クリック」扱いにする(EventBlock の CLICK_THRESHOLD_PX と同じ考え方) */
const CREATE_CLICK_THRESHOLD_PX = 4;
/**
 * モバイル対応フェーズ2(docs/multiplatform.md): longPressCreate が true のとき、
 * 空き領域を押してから作成ドラッグを開始するまでの遅延。この間に一定量動いたら
 * 「スクロールしようとした」とみなして作成をキャンセルする(LONG_PRESS_MOVE_CANCEL_PX)。
 */
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_CANCEL_PX = 10;

interface CreateDragState {
  pointerId: number;
  moved: boolean;
  startClientY: number;
  /** 日列 DOM の getBoundingClientRect().top (px, viewport 座標) */
  columnTop: number;
  /** ドラッグ開始点をスナップした epoch ms (アンカー、上にも下にも伸ばせる) */
  anchorMs: number;
  pendingStartMs: number;
  pendingEndMs: number;
  ghostEl: HTMLDivElement;
}

/** 長押し判定待ちの状態(longPressCreate モードのみ使う)。タイマー発火前に一定量動くとキャンセルする */
interface LongPressPendingState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  columnEl: HTMLDivElement;
}

/** pointerup で確定した、タイトル入力待ちの新規予定の時間帯 */
interface DraftRange {
  startMs: number;
  endMs: number;
}

interface DayColumnProps {
  dayIndex: number;
  dayStartMs: number;
  dayEndMs: number;
  isToday: boolean;
  nowMs: number;
  positioned: ReturnType<typeof packColumns<OccurrenceGroup>>;
  timeZone: string;
  weekDayStarts: readonly number[];
  onCommit: (updated: Occurrence) => void;
  onDelete: (occurrence: Occurrence) => void;
  calendarLookup: Map<string, CalendarInfo>;
  /** 新規予定の書き込み先。null なら(未連携・カレンダー未選択)空き領域クリックでの作成を無効化する */
  writeTarget: WriteTargetCandidate | null;
  onCreateEvent: (
    startMs: number,
    endMs: number,
    title: string,
    target: WriteTargetCandidate,
  ) => void;
  /**
   * モバイル対応フェーズ2: true のとき、空き領域からの新規作成トリガーを即時クリックではなく
   * 長押し(LONG_PRESS_MS)起点にする(タッチのネイティブ縦スクロールと競合しないようにするため)。
   * 省略時は false(既存のデスクトップ向け即時クリック挙動)
   */
  longPressCreate?: boolean;
}

/**
 * 週グリッドの1日ぶんの列。EventBlock 群の描画に加えて、空き領域の
 * クリック/縦ドラッグによる新規予定作成(フェーズ5)を持つ。
 *
 * 新規作成のトリガー判定: この列の pointerdown ハンドラは `e.target === e.currentTarget`
 * のときだけ反応する(= pointerdown が列の背景そのもので発生した場合のみ)。
 * EventBlock 自身の pointerdown は stopPropagation していないためこの列までバブルするが、
 * その場合 e.target は EventBlock 側の DOM ノードになるので自然に無視される
 * (子要素上のクリックを親側で target 比較だけで弾く、追加の stopPropagation 変更は不要)。
 */
export function DayColumn({
  dayIndex,
  dayStartMs,
  dayEndMs,
  isToday,
  nowMs,
  positioned,
  timeZone,
  weekDayStarts,
  onCommit,
  onDelete,
  calendarLookup,
  writeTarget,
  onCreateEvent,
  longPressCreate = false,
}: DayColumnProps) {
  const createDragRef = useRef<CreateDragState | null>(null);
  const longPressPendingRef = useRef<LongPressPendingState | null>(null);
  const longPressTimerRef = useRef<number | undefined>(undefined);
  const [draft, setDraft] = useState<DraftRange | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const draftRef = useRef<HTMLDivElement>(null);
  const draftInputRef = useRef<HTMLInputElement>(null);

  const showNowLine = isToday && nowMs >= dayStartMs && nowMs < dayEndMs;
  const nowTop = minutesToPx((nowMs - dayStartMs) / 60_000);

  // カスケードの前面/背面(WeekGrid.tsx から移設、ロジックは変更なし)
  const stackZ = new Map<string, number>();
  positioned
    .map((p) => p.item.primary)
    .sort((a, b) => {
      const busyA = isBusyPlaceholder(a.title) ? 0 : 1;
      const busyB = isBusyPlaceholder(b.title) ? 0 : 1;
      return busyA - busyB || a.startMs - b.startMs || b.endMs - a.endMs;
    })
    .forEach((occ, rank) => stackZ.set(occ.id, rank));

  const busyIntervals = positioned
    .map((p) => p.item.primary)
    .filter((occ) => isBusyPlaceholder(occ.title))
    .map((occ) => ({
      startMs: occ.startMs,
      endMs: occ.endMs,
      color: resolveDisplayColor(occ, calendarLookup),
    }));

  function cancelDraft() {
    setDraft(null);
    setDraftTitle("");
  }

  useCloseOnOutsideOrEscape(draft !== null, draftRef, cancelDraft);

  // アンマウント時に長押しタイマーが残らないようにする(pointerup/cancel を取りこぼした場合の保険)
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current !== undefined) window.clearTimeout(longPressTimerRef.current);
    };
  }, []);

  /**
   * 実際の作成ドラッグ状態を起こす(desktop の即時クリック起点、longPressCreate の
   * 長押し確定時起点の両方から呼ばれる)。moved=true で呼ぶと ghost をその場で
   * 表示する(長押し確定の瞬間に「作成モードに入った」ことを視覚的に示すため)。
   */
  function beginCreateDrag(
    columnEl: HTMLDivElement,
    pointerId: number,
    clientY: number,
    moved: boolean,
  ) {
    const rect = columnEl.getBoundingClientRect();
    const rawMs = dayStartMs + pxToMinutes(clientY - rect.top) * 60_000;
    const anchorMs = snapStartMs(rawMs, { originalStartMs: rawMs });
    const ghostEl = document.createElement("div");
    ghostEl.className = "day-column-create-ghost";
    const pendingStartMs = anchorMs;
    const pendingEndMs = anchorMs + DEFAULT_CREATE_DURATION_MS;
    createDragRef.current = {
      pointerId,
      moved,
      startClientY: clientY,
      columnTop: rect.top,
      anchorMs,
      pendingStartMs,
      pendingEndMs,
      ghostEl,
    };
    if (moved) {
      columnEl.appendChild(ghostEl);
      ghostEl.style.top = `${minutesToPx((pendingStartMs - dayStartMs) / 60_000)}px`;
      ghostEl.style.height = `${Math.max(minutesToPx((pendingEndMs - pendingStartMs) / 60_000), 4)}px`;
    }
  }

  function clearLongPressPending() {
    if (longPressTimerRef.current !== undefined) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = undefined;
    }
    longPressPendingRef.current = null;
  }

  // 注: この列に touch-action: none は付けない(EventBlock の .event と違い列全体が
  // 縦スクロール領域と重なるため、付けるとタッチでのスクロールを壊してしまう)。
  // longPressCreate===false(デスクトップ想定)では本作成ドラッグとタッチのネイティブ
  // スクロールが競合しうるが許容する。longPressCreate===true(狭幅モバイル)では
  // 下記のとおり長押し確定までは何もキャプチャしないことでスクロールを妨げない。
  function handleColumnPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    if (e.target !== e.currentTarget) return; // 空き領域の背景そのもの以外(イベントカード等)では発火させない
    if (!writeTarget) return; // 書き込み先カレンダーが無ければ新規作成不可

    if (longPressCreate) {
      // ここでは setPointerCapture も preventDefault も行わない(縦スクロールを妨げない)。
      // LONG_PRESS_MS 後、大きく動いていなければ長押し確定として作成ドラッグを開始する
      // (この時点で setPointerCapture することで、以後の pointermove はスクロールへ流れず
      // このハンドラへ配送される — ブラウザのポインタキャプチャの標準的な使い方)
      const columnEl = e.currentTarget;
      const pointerId = e.pointerId;
      longPressPendingRef.current = {
        pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        columnEl,
      };
      longPressTimerRef.current = window.setTimeout(() => {
        const pending = longPressPendingRef.current;
        longPressTimerRef.current = undefined;
        if (!pending || pending.pointerId !== pointerId) return;
        longPressPendingRef.current = null;
        try {
          pending.columnEl.setPointerCapture(pointerId);
        } catch {
          /* 既にポインタが離れている等は無視 */
        }
        beginCreateDrag(pending.columnEl, pointerId, pending.startClientY, true);
      }, LONG_PRESS_MS);
      return;
    }

    e.currentTarget.setPointerCapture(e.pointerId);
    beginCreateDrag(e.currentTarget, e.pointerId, e.clientY, false);
  }

  function handleColumnPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const pending = longPressPendingRef.current;
    if (pending && pending.pointerId === e.pointerId) {
      // 長押し確定前に一定量動いたらスクロール操作とみなし、作成をキャンセルする
      const dx = e.clientX - pending.startClientX;
      const dy = e.clientY - pending.startClientY;
      if (Math.hypot(dx, dy) >= LONG_PRESS_MOVE_CANCEL_PX) {
        clearLongPressPending();
      }
      return;
    }

    const ds = createDragRef.current;
    if (!ds || ds.pointerId !== e.pointerId) return;
    if (!ds.moved && Math.abs(e.clientY - ds.startClientY) >= CREATE_CLICK_THRESHOLD_PX) {
      ds.moved = true;
      e.currentTarget.appendChild(ds.ghostEl);
    }
    if (!ds.moved) return;

    const rawMs = dayStartMs + pxToMinutes(e.clientY - ds.columnTop) * 60_000;
    const snapped = snapStartMs(rawMs, { originalStartMs: rawMs });
    const startMs = Math.min(ds.anchorMs, snapped);
    const endMs = Math.max(Math.max(ds.anchorMs, snapped), startMs + SNAP_MS);
    ds.pendingStartMs = startMs;
    ds.pendingEndMs = endMs;

    ds.ghostEl.style.top = `${minutesToPx((startMs - dayStartMs) / 60_000)}px`;
    ds.ghostEl.style.height = `${Math.max(minutesToPx((endMs - startMs) / 60_000), 4)}px`;
  }

  function handleColumnPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const pending = longPressPendingRef.current;
    if (pending && pending.pointerId === e.pointerId) {
      // 長押しが確定する前に指を離した = タップ扱い、何も作成しない
      clearLongPressPending();
      return;
    }

    const ds = createDragRef.current;
    if (!ds || ds.pointerId !== e.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* すでに解放済みなら無視 */
    }
    ds.ghostEl.remove();
    createDragRef.current = null;

    // moved かどうかに関わらず pendingStartMs/pendingEndMs は常に妥当な範囲を保持している
    // (moved===false のときは初期値 = anchor + デフォルト1時間のまま)
    setDraft({ startMs: ds.pendingStartMs, endMs: ds.pendingEndMs });
    setDraftTitle("");
    // 次の描画でマウントされる input に自動でフォーカスする
    requestAnimationFrame(() => draftInputRef.current?.focus());
  }

  function handleColumnPointerCancel(e: ReactPointerEvent<HTMLDivElement>) {
    const pending = longPressPendingRef.current;
    if (pending && pending.pointerId === e.pointerId) {
      clearLongPressPending();
      return;
    }

    const ds = createDragRef.current;
    if (!ds || ds.pointerId !== e.pointerId) return;
    ds.ghostEl.remove();
    createDragRef.current = null;
  }

  function confirmDraft() {
    const title = draftTitle.trim();
    if (draft && writeTarget && title.length > 0) {
      onCreateEvent(draft.startMs, draft.endMs, title, writeTarget);
    }
    cancelDraft();
  }

  return (
    <div
      className={isToday ? "week-grid-day-column is-today" : "week-grid-day-column"}
      onPointerDown={handleColumnPointerDown}
      onPointerMove={handleColumnPointerMove}
      onPointerUp={handleColumnPointerUp}
      onPointerCancel={handleColumnPointerCancel}
    >
      {positioned.map(({ item: group, column, columnCount }) => {
        const occurrence = group.primary;
        const durationMin = (occurrence.endMs - occurrence.startMs) / 60_000;
        const isCompact = durationMin < COMPACT_THRESHOLD_MIN;
        const topPx = minutesToPx((occurrence.startMs - dayStartMs) / 60_000);
        const heightPx = Math.max(minutesToPx(durationMin), 4);
        const step = cascadeStepFrac(columnCount);
        const leftPct = column * step * 100;
        const widthPct = 100 - leftPct;
        const stackIndex = stackZ.get(occurrence.id) ?? column;
        const blockedByBusyColors = isBusyPlaceholder(occurrence.title)
          ? []
          : busyOverlapColors(occurrence, busyIntervals);

        return (
          <EventBlock
            key={occurrence.id}
            occurrence={occurrence}
            groupMembers={group.members}
            stackIndex={stackIndex}
            top={topPx}
            height={heightPx}
            leftPct={leftPct}
            widthPct={widthPct}
            isCompact={isCompact}
            blockedByBusyColors={blockedByBusyColors}
            timeZone={timeZone}
            dayIndex={dayIndex}
            dayStartMs={dayStartMs}
            weekDayStarts={weekDayStarts}
            onCommit={onCommit}
            onDelete={onDelete}
            calendarLookup={calendarLookup}
          />
        );
      })}
      {showNowLine && (
        <div className="now-line" style={{ top: nowTop }}>
          <span className="now-line-dot" />
        </div>
      )}
      {draft && (
        <div
          ref={draftRef}
          className="day-column-create-draft"
          style={{
            top: minutesToPx((draft.startMs - dayStartMs) / 60_000),
            height: Math.max(minutesToPx((draft.endMs - draft.startMs) / 60_000), 4),
          }}
        >
          <input
            ref={draftInputRef}
            type="text"
            className="day-column-create-input"
            placeholder="予定のタイトル"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                confirmDraft();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelDraft();
              }
            }}
          />
        </div>
      )}
    </div>
  );
}
