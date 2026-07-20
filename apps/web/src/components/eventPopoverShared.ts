/**
 * EventBlock (時刻予定) と AllDayBar (終日予定、フェーズ5) の両方から使う、
 * ホバーツールチップ・詳細ポップオーバー位置決めの純粋な DOM ヘルパー群。
 * react-refresh の "ファイルはコンポーネントのみ export すべき" ルールに
 * 抵触しないよう、コンポーネントを持つ EventBlock.tsx とは別ファイルに分離してある。
 */

const TOOLTIP_OFFSET_PX = 14;

/**
 * ホバーツールチップは全 EventBlock/AllDayBar で1個の DOM ノードを使い回す
 * (drag-badge と同じ流儀: React 管理下に置かず、直接 DOM 操作で表示/非表示・
 * 位置更新する)。同時にホバーできるブロックは常に1つなので、シングルトンで十分。
 */
let sharedTooltipEl: HTMLDivElement | null = null;
export function getSharedTooltipEl(): HTMLDivElement {
  if (!sharedTooltipEl) {
    sharedTooltipEl = document.createElement("div");
    sharedTooltipEl.className = "event-tooltip";
    sharedTooltipEl.style.display = "none";
    document.body.appendChild(sharedTooltipEl);
  }
  return sharedTooltipEl;
}

export function positionTooltip(el: HTMLDivElement, clientX: number, clientY: number) {
  el.style.transform = `translate(${clientX + TOOLTIP_OFFSET_PX}px, ${clientY + TOOLTIP_OFFSET_PX}px)`;
}

/**
 * 共有ツールチップ要素の中身を埋める。時刻予定 (EventBlock) は「10:00 – 11:00」、
 * 終日予定 (AllDayBar) は「7月20日〜7月22日」のように rangeLabel の中身だけが
 * 違うため、フォーマット済み文字列を受け取る形にして両方から使えるようにしてある。
 */
export function fillTooltipContent(
  el: HTMLDivElement,
  title: string,
  rangeLabel: string,
  location?: string,
): void {
  el.replaceChildren();

  const titleEl = document.createElement("div");
  titleEl.className = "event-tooltip-title";
  titleEl.textContent = title;
  el.appendChild(titleEl);

  const rangeEl = document.createElement("div");
  rangeEl.className = "event-tooltip-range";
  rangeEl.textContent = rangeLabel;
  el.appendChild(rangeEl);

  if (location) {
    const locationEl = document.createElement("div");
    locationEl.className = "event-tooltip-location";
    locationEl.textContent = location;
    el.appendChild(locationEl);
  }
}

/**
 * Google の description は HTML を含み得るため、表示前にプレーンテキスト化する。
 * ブロック境界 (<br>/<p>/<div>/<li>) を改行に変換してから DOMParser でタグを剥がす
 * ("要素の textContent" は改行を保持しないため、これをしないと段落が繋がって読みにくくなる)。
 * 厳密な HTML→text 変換ではなく、詳細ポップオーバーで読める程度の簡易処理。
 */
export function stripHtmlToPlainText(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n");
  const doc = new DOMParser().parseFromString(withBreaks, "text/html");
  const text = doc.body.textContent ?? "";
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** 詳細ポップオーバーの想定サイズ。ビューポート外にはみ出さないようクランプするための概算値 */
const DETAIL_POPOVER_WIDTH = 300;
const DETAIL_POPOVER_MAX_HEIGHT = 420;
const DETAIL_POPOVER_MARGIN = 8;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

export function clampPopoverPosition(x: number, y: number): { left: number; top: number } {
  const maxLeft = Math.max(
    DETAIL_POPOVER_MARGIN,
    window.innerWidth - DETAIL_POPOVER_WIDTH - DETAIL_POPOVER_MARGIN,
  );
  const maxTop = Math.max(
    DETAIL_POPOVER_MARGIN,
    window.innerHeight - DETAIL_POPOVER_MAX_HEIGHT - DETAIL_POPOVER_MARGIN,
  );
  return {
    left: clamp(x, DETAIL_POPOVER_MARGIN, maxLeft),
    top: clamp(y, DETAIL_POPOVER_MARGIN, maxTop),
  };
}
