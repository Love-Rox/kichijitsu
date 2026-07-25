import { useMemo, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import {
  classifySwipeAxis,
  computeTrailingVelocity,
  resolveSwipeOutcome,
  SWIPE_VELOCITY_WINDOW_MS,
  type SwipeAxis,
  type SwipeSample,
} from "../layout/swipeNav";

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
 * 5. マルチタッチ(2本目以降の指): 追跡中の状態を絶対に上書きしない ―― 上書きすると1本目の
 *    pointerup で finish() が pointerId 不一致で早期 return し、.is-swiping と --swipe-dx が
 *    付いたまま固まる(= 以後の日付移動アニメーションが全部 transition:none で瞬間移動になる)。
 *    - まだ横確定していない(pending)うちに2本目が触れたら、その追跡は破棄する
 *      (2本指スクロール/ピンチを横スワイプと誤認しないため。まだ何も始めていないので副作用なし)。
 *    - すでに横確定して追従中なら1本目を追い続ける(2本目が触れただけで指追従を打ち切ると、
 *      実際にスワイプしている指が意図せず戻される体感になる)。ブラウザがピンチズーム等を
 *      開始した場合は1本目に pointercancel が届くので、そこで stay として後片付けされる。
 * 6. 後片付けの保険: pointerup/pointercancel だけでなく lostpointercapture も購読する ――
 *    キャプチャ中の要素が DOM から外れた/他所が同じ pointerId を奪った等で pointerup が
 *    届かない経路でも、必ず onSwipeEnd("stay") を通して .is-swiping を落とす。
 */

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
  /** 横スワイプが確定した瞬間(指追従の開始)。WeekGrid は transition を切って 1:1 追従にする */
  onSwipeStart: () => void;
  /** 追従中、pointerdown からの水平移動量(px)を反映する。WeekGrid は --swipe-dx を命令的にセット */
  onSwipeMove: (dxPx: number) => void;
  /** 指を離した/中断したときの決着。"prev"/"next"=隣パネルへ確定、"stay"=元位置へ戻す */
  onSwipeEnd: (outcome: "prev" | "next" | "stay") => void;
}

/** pointerdown からの追跡状態。React state ではなく ref で持つ(pointermove のたびに
 * 再レンダーせず、実際にストリップが動くべきときだけ setDragDxPx で反映するため) */
interface TrackState {
  pointerId: number;
  startX: number;
  startY: number;
  /** 横確定後の pointermove の (x, time) 履歴。末尾が最新(昇順)。フリック速度は
   * 「離す直前の一定時間窓」で測るため、直近1点でなくこの履歴から算出する
   * (computeTrailingVelocity)。古いサンプルは onPointerMove で間引く。 */
  samples: SwipeSample[];
  axis: SwipeAxis;
  /** pointerdown 時点で測った1パネルぶんの表示幅(px) */
  panelWidthPx: number;
}

/** samples の肥大化を防ぐため、速度窓の2倍より古いサンプルは捨てる(端点差分に十分な余裕) */
const SAMPLE_RETENTION_MS = SWIPE_VELOCITY_WINDOW_MS * 2;

/** pointerdown 時、この中(またはその子孫)から始まったジェスチャはスワイプ候補にしない */
const SWIPE_EXCLUDE_SELECTOR =
  ".event, .planned-block, .event-detail-popover, .event-detail-backdrop, input, textarea, button, a";

export interface SwipeNavigationHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  /** 後片付けの保険(上記 6)。pointerup/cancel を取りこぼす経路でも stay で必ず終わらせる */
  onLostPointerCapture: (e: ReactPointerEvent<HTMLElement>) => void;
}

export function useSwipeNavigation({
  enabled,
  viewportRef,
  onSwipeStart,
  onSwipeMove,
  onSwipeEnd,
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

      // マルチタッチ(2本目以降の指): 進行中の追跡は絶対に上書きしない(上書きすると1本目の
      // pointerup で finish() が pointerId 不一致で早期 return し、.is-swiping が残って
      // 以後の日付移動アニメーションが全部瞬間移動になる)。詳細は冒頭コメント 5。
      const active = trackRef.current;
      if (active) {
        // pending(まだ横確定していない)ならこの追跡自体を捨てる ―― 2本指スクロールや
        // ピンチの片方を横スワイプと誤認して日付を送ってしまわないようにする。
        // 横確定済みなら 1本目をそのまま追い続ける(勝手に打ち切らない)。
        if (active.axis === "pending") reset();
        return;
      }

      const target = e.target as HTMLElement | null;
      if (target?.closest(SWIPE_EXCLUDE_SELECTOR)) return;

      trackRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        samples: [{ x: e.clientX, time: e.timeStamp }],
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
        // "horizontal" 確定: ここで初めてポインタを掴み、指追従を開始する(WeekGrid が transition を切る)
        t.axis = "horizontal";
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* 既にポインタが離れている等は無視(DayColumn と同じ流儀) */
        }
        onSwipeStart();
      }

      if (t.axis !== "horizontal") return;
      // 速度算出用にサンプルを追記し、古すぎるものを間引く(端点差分で勢いを測る)
      t.samples.push({ x: e.clientX, time: e.timeStamp });
      const cutoff = e.timeStamp - SAMPLE_RETENTION_MS;
      while (t.samples.length > 2 && t.samples[0].time < cutoff) {
        t.samples.shift();
      }
      onSwipeMove(dx);
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
        onSwipeEnd("stay");
        return;
      }

      const dx = e.clientX - t.startX;
      // pointerup 地点も最新サンプルとして加え、離す直前の一定時間窓で速度(px/ms)を測る。
      // 直近1点だけだと指を止めてから離したとき速度 0 になりフリックが効かないため。
      t.samples.push({ x: e.clientX, time: e.timeStamp });
      const velocityPxPerMs = computeTrailingVelocity(t.samples);
      const outcome = resolveSwipeOutcome({
        dxPx: dx,
        panelWidthPx: t.panelWidthPx,
        velocityPxPerMs,
      });
      // outcome の適用(transition 復帰・--swipe-dx=0 へのスナップ・確定時のナビゲーション)は
      // WeekGrid の handleSwipeEnd 側で行う。純ロジックはここで outcome を決めるところまで。
      onSwipeEnd(outcome);
    }

    /**
     * 追従中にポインタキャプチャを失った場合の保険(冒頭コメント 6)。
     * 通常の pointerup 経路では finish() が先に走って trackRef を空にしているので、ここは
     * 何もしない(仕様上 lostpointercapture は pointerup/pointercancel の直後に発火する)。
     * キャプチャ中の要素が DOM から消えた・他のコードが同じ pointerId を奪った等で
     * pointerup が届かない経路だけがここに来るため、stay 扱いで確実に後片付けする ――
     * .is-swiping が残ると以後の日付移動が全部 transition:none で瞬間移動になるのを防ぐ。
     */
    function onLostPointerCapture(e: ReactPointerEvent<HTMLElement>) {
      // lostpointercapture は bubbles: true ―― 子孫(長押し確定した DayColumn 等)が
      // キャプチャを失ったイベントもここへ上がってくる。特にこのフックが横スワイプ確定時に
      // DayColumn からキャプチャを奪った直後は、まさに同じ pointerId の lostpointercapture が
      // 子から届くため、target で絞らないと始まったばかりのスワイプを自分で打ち切ってしまう。
      // 自分(=キャプチャを取った要素そのもの)が失った場合だけ後片付けする。
      if (e.target !== e.currentTarget) return;
      const t = trackRef.current;
      if (!t || t.pointerId !== e.pointerId) return;
      reset();
      if (t.axis !== "horizontal") return; // 追従を始めていなければ知らせるべき終了は無い
      onSwipeEnd("stay");
    }

    return {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e) => finish(e, true),
      onPointerCancel: (e) => finish(e, false),
      onLostPointerCapture,
    };
    // trackRef は ref なので依存に含めない(同一インスタンスを使い続ける)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, viewportRef, onSwipeStart, onSwipeMove, onSwipeEnd]);
}
