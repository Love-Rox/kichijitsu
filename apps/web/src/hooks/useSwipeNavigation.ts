import { useMemo, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { classifySwipeAxis, resolveSwipeOutcome, type SwipeAxis } from "../layout/swipeNav";

/**
 * スマホでのスワイプ日付移動(モバイル対応フェーズ2 増分、2026-07-22)の DOM 配線。
 * 判定・数値計算そのものは layout/swipeNav.ts の純関数に委譲し、ここでは
 * pointerdown/move/up/cancel の購読と setPointerCapture、WeekGrid.tsx が持つ
 * 既存のスライド state(instant/phase 等)への橋渡しだけを行う(薄い配線に留める ―― 実 DOM
 * 挙動のユニットテストは困難なため、テストは swipeNav.ts 側の純ロジックで固めてある)。
 *
 * 競合回避の要 ――
 * 1. イベントカード(.event)・予定タイムブロック(.planned-block)・詳細ポップオーバー
 *    (.event-detail-popover/.event-detail-backdrop)・フォーム部品(input/textarea/button/a)
 *    上で始まった pointerdown は最初から無視する(それらは自前の pointer ドラッグ/タップを
 *    持つため、このフックは一切介入しない)。
 * 2. それ以外の背景で始まった pointerdown は「判定待ち」として dx/dy の観測だけ始める
 *    (setPointerCapture も preventDefault もまだしない ―― DayColumn の長押し新規作成・
 *    縦スクロールを一切妨げない)。
 * 3. pointermove のたびに classifySwipeAxis で方向を判定し、"horizontal" が確定した
 *    瞬間に初めて setPointerCapture してストリップの追従を開始する。DayColumn 側の
 *    長押し待ち(longPressPendingRef)は「移動量 10px」で自己キャンセルするようにできており
 *    (DayColumn.tsx LONG_PRESS_MOVE_CANCEL_PX)、このフックの横方向確定閾値と同程度で
 *    先に自己キャンセルするため、明示的な相互キャンセル通信をしなくても衝突しない。
 * 4. "vertical" と判定された場合は即座に諦める(以後のイベントを無視する)。DayColumn の
 *    縦スクロール・長押し作成・(desktop の)即時作成ドラッグはそのまま自然に進行する。
 */

/** 追従中の水平オフセット(px)。0 に戻すとストリップが基準位置に戻る */
export type SetDragDxPx = (px: number) => void;
/** WeekGrid.tsx が持つ instant state のセッター。true=transition なし(指追従用)、false=transition あり(snap 用) */
export type SetInstant = (instant: boolean) => void;

export interface UseSwipeNavigationOptions {
  /**
   * このジェスチャを有効化するかどうか。WeekGrid.tsx からは
   * `longPressCreate && phase === 'idle'` を渡す想定 ――
   * - longPressCreate(=isNarrow、モバイル幅)でのみ有効にする。デスクトップの
   *   即時作成ドラッグ(longPressCreate=false)は pointerdown 直後から createDragRef を
   *   確立してしまい、横スワイプ後の pointerup で意図せず新規作成の入力欄が開いてしまう
   *   ため(DayColumn.tsx 参照)、スコープ外として明示的に除外する(要件5、マウス/デスクトップは対象外)。
   * - phase === 'idle' のときだけ許可し、前回のスナップアニメーション中に次のスワイプが
   *   割り込んで表示が破綻しないようにする。
   */
  enabled: boolean;
  /** 1パネルぶんの表示幅(px)を測るための ref(days-viewport 要素を想定) */
  viewportRef: RefObject<HTMLElement | null>;
  /** 横スワイプが確定し、pointerup で prev/next が決まったときに呼ばれる */
  onNavigate: (direction: "prev" | "next") => void;
  /** 追従中の transform オフセットを反映する(WeekGrid.tsx の state セッター) */
  setDragDxPx: SetDragDxPx;
  /** 指追従中は true(transition 無効)、確定/キャンセル時は false(transition 復帰)にする */
  setInstant: SetInstant;
}

/** pointerdown からの追跡状態。React state ではなく ref で持つ(pointermove のたびに
 * 再レンダーせず、実際にストリップが動くべきときだけ setDragDxPx で反映するため) */
interface TrackState {
  pointerId: number;
  startX: number;
  startY: number;
  /** 直近の pointermove のクライアント座標・時刻(フリック速度算出用) */
  lastX: number;
  lastTime: number;
  axis: SwipeAxis;
  /** pointerdown 時点で測った1パネルぶんの表示幅(px) */
  panelWidthPx: number;
}

/** pointerdown 時、この中(またはその子孫)から始まったジェスチャはスワイプ候補にしない */
const SWIPE_EXCLUDE_SELECTOR =
  ".event, .planned-block, .event-detail-popover, .event-detail-backdrop, input, textarea, button, a";

export interface SwipeNavigationHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
}

export function useSwipeNavigation({
  enabled,
  viewportRef,
  onNavigate,
  setDragDxPx,
  setInstant,
}: UseSwipeNavigationOptions): SwipeNavigationHandlers {
  const trackRef = useRef<TrackState | null>(null);

  return useMemo<SwipeNavigationHandlers>(() => {
    function reset() {
      trackRef.current = null;
    }

    function onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      if (!enabled) return;
      // タッチ主体(要件5): マウス/ペン起点では起動しない。デスクトップの即時作成ドラッグ
      // (背景クリックでの新規作成)と競合しうるため、意図的にタッチのみへ絞る。
      if (e.pointerType !== "touch") return;
      const target = e.target as HTMLElement | null;
      if (target?.closest(SWIPE_EXCLUDE_SELECTOR)) return;

      trackRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastTime: e.timeStamp,
        axis: "pending",
        panelWidthPx: viewportRef.current?.clientWidth ?? 0,
      };
      // ここでは setPointerCapture も preventDefault も行わない ――
      // まだ横スワイプと確定していない(DayColumn の縦スクロール/長押し作成を妨げないため)。
    }

    function onPointerMove(e: ReactPointerEvent<HTMLElement>) {
      const t = trackRef.current;
      if (!t || t.pointerId !== e.pointerId) return;

      const dx = e.clientX - t.startX;
      const dy = e.clientY - t.startY;

      if (t.axis === "pending") {
        const axis = classifySwipeAxis(dx, dy);
        if (axis === "pending") return; // まだ判定保留、様子見を続ける
        if (axis === "vertical") {
          reset(); // 縦優勢: 以後は一切介入しない(スクロール/長押し作成に委ねる)
          return;
        }
        // "horizontal" 確定: ここで初めてポインタを掴み、指追従の transition を切る
        t.axis = "horizontal";
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* 既にポインタが離れている等は無視(DayColumn と同じ流儀) */
        }
        setInstant(true);
      }

      if (t.axis !== "horizontal") return;
      t.lastX = e.clientX;
      t.lastTime = e.timeStamp;
      setDragDxPx(dx);
    }

    function finish(e: ReactPointerEvent<HTMLElement>, commit: boolean) {
      const t = trackRef.current;
      if (!t || t.pointerId !== e.pointerId) return;
      reset();
      if (t.axis !== "horizontal") return; // 一度も横スワイプとして確定していない

      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* 既に解放済みなら無視 */
      }

      if (!commit) {
        // pointercancel 等: 位置を戻すだけ(前後どちらへも確定しない)
        setInstant(false);
        setDragDxPx(0);
        return;
      }

      const dx = e.clientX - t.startX;
      // 直近のサンプル間の速度(px/ms)。フリック(速い離し)の検知に使う
      const dt = Math.max(1, e.timeStamp - t.lastTime);
      const velocityPxPerMs = (e.clientX - t.lastX) / dt;
      const outcome = resolveSwipeOutcome({
        dxPx: dx,
        panelWidthPx: t.panelWidthPx,
        velocityPxPerMs,
      });

      // transition を復帰させる: "stay" はここで自前で 0 へスナップバックする(要件どおり
      // 「戻す場合は translateX を 0 に戻すだけ」)。"prev"/"next" は WeekGrid.tsx 側の
      // weekStart 変更検知 useEffect が phase 切り替えと同時に dragDxPx も 0 へ戻すため、
      // ここでは onNavigate を呼ぶだけでよい(二重に戻すと逆に一瞬中央へ戻ってから
      // スライドし直す不自然な動きになるため、意図的に setDragDxPx を呼ばない)。
      setInstant(false);
      if (outcome === "stay") {
        setDragDxPx(0);
        return;
      }
      onNavigate(outcome);
    }

    return {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e) => finish(e, true),
      onPointerCancel: (e) => finish(e, false),
    };
    // trackRef は ref なので依存に含めない(同一インスタンスを使い続ける)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, viewportRef, onNavigate, setDragDxPx, setInstant]);
}
