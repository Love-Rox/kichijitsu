import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  fillTooltipContent,
  getSharedTooltipEl,
  positionTooltip,
} from "../components/eventPopoverShared";

/** ホバーからツールチップが出るまでの待ち時間(ms)。全ての予定系 UI で共通 */
const HOVER_DELAY_MS = 400;

/** ツールチップに出す3行(location は無ければ省略される) */
export interface HoverTooltipContent {
  title: string;
  rangeLabel: string;
  location?: string;
}

export interface HoverTooltipHandlers {
  onPointerEnter: (e: ReactPointerEvent<Element>) => void;
  /** 表示中のツールチップをポインタに追従させる(表示していなければ何もしない) */
  onPointerMove: (e: ReactPointerEvent<Element>) => void;
  onPointerLeave: () => void;
  /** ドラッグ開始・クリックで詳細を開く等、ホバー以外の操作が始まったとき呼ぶ */
  hide: () => void;
}

/**
 * 予定系 UI 共通のホバーツールチップ(2026-07-25 リファクタ フェーズ1a)。
 *
 * なぜ hook にしたか: EventBlock / AllDayBar / OooRailLine / WorkingLocationRailBand の
 * 4コンポーネントに、hoverTimeoutRef + tooltipShownRef + showTooltip/hideTooltip +
 * pointerenter/move/leave という同じ実装(HOVER_DELAY_MS = 400 の再定義込み)が写されていた。
 * DOM 操作自体は components/eventPopoverShared.ts で既に共有済みだったので、残っていた
 * 「タイマーと表示状態の管理」だけをここに集約する。
 *
 * 規律(元の4実装から引き継いだもの):
 * - 表示/非表示・位置更新は React state を通さず共有 DOM ノードへ直接書く(drag-badge と同じ流儀)。
 *   同時にホバーできる要素は1つなのでノードはシングルトンでよい(eventPopoverShared.ts 参照)。
 * - content は「表示する瞬間」に呼ぶ遅延評価にしてある ―― タイマー発火前にホバーが
 *   終わった場合にラベル整形(会議 URL のラベル化など)を無駄に走らせないため。
 * - suppress はドラッグ中のように「ホバーしていても出してはいけない」状態を表す。
 *   pointerenter 時とタイマー発火時の2回評価する(元の EventBlock 実装と同じ ―― 待ち時間の
 *   途中でドラッグが始まったら出さない)。
 * - アンマウント時は必ず hide する。ツールチップは共有ノードなので、消し忘れると
 *   「もう存在しない要素のツールチップが出たまま残る」ことになる(元は EventBlock だけが
 *   この後始末を持っていた ―― hook 化に伴い4箇所すべてが同じ保証を得る)。
 */
export function useHoverTooltip(
  content: () => HoverTooltipContent,
  opts?: { delayMs?: number; suppress?: () => boolean },
): HoverTooltipHandlers {
  const timeoutRef = useRef<number | undefined>(undefined);
  const shownRef = useRef(false);
  const delayMs = opts?.delayMs ?? HOVER_DELAY_MS;
  const suppress = opts?.suppress;

  function hide() {
    if (timeoutRef.current !== undefined) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
    }
    if (shownRef.current) {
      getSharedTooltipEl().style.display = "none";
      shownRef.current = false;
    }
  }

  function show(clientX: number, clientY: number) {
    const { title, rangeLabel, location } = content();
    const el = getSharedTooltipEl();
    fillTooltipContent(el, title, rangeLabel, location);
    el.style.display = "block";
    positionTooltip(el, clientX, clientY);
    shownRef.current = true;
  }

  // 後始末は ref しか触らないので、初回 render のクロージャをそのまま使ってよい
  // (依存配列は空 = アンマウント時のみ実行)
  useEffect(() => {
    return hide;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    onPointerEnter(e) {
      if (suppress?.()) return;
      // イベントオブジェクトは非同期で参照できないため座標だけ控える
      const clientX = e.clientX;
      const clientY = e.clientY;
      timeoutRef.current = window.setTimeout(() => {
        timeoutRef.current = undefined;
        if (suppress?.()) return; // 待ち時間の途中でドラッグ等が始まっていたら出さない
        show(clientX, clientY);
      }, delayMs);
    },
    onPointerMove(e) {
      if (shownRef.current) {
        positionTooltip(getSharedTooltipEl(), e.clientX, e.clientY);
      }
    },
    onPointerLeave: hide,
    hide,
  };
}
