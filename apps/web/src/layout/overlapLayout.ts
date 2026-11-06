/**
 * 週ビューの「重なる予定」の横位置を決める純関数(UI 刷新 段階3)。
 *
 * 旧来のカスケード(layout/packColumns.ts の列番号 × cascadeStepFrac)は、列の割り当ては
 * 正しいのに、描画が「左端を 14% ずつずらして幅は残り全部」だった。カードは不透明なので、
 * 後から描いたカードが先のカードの見出し(時刻+タイトル)を覆い、「13:0」のような断片しか
 * 見えなくなっていた。ここでは「見出しだけは必ず読める」ことを配置の条件にする。
 *
 * 規則:
 * 1. 背景層(Busy・辞退など)は他の予定の幅を奪わない。全幅・最背面に置く。
 * 2. 本体の予定は、見出しの窓 [start, start + headerMs) どうしが重なるものを別のレーン
 *    (横に並ぶ)に置く。窓が重ならない予定は同じレーンに置き、後の予定が先の予定の
 *    本文部分に乗る(見出しは覆われない)。
 * 3. 同じレーンで乗り合う予定は STACK_INDENT_FRAC ずつ右にずらし、先の予定の端が見えて
 *    「その下にも続いている」と分かるようにする。
 * 4. 予定は右の空きレーンまで幅を広げる。ただし、見出しの窓が重なる予定のいるレーンは
 *    越えない(越えると見出しを覆うため)。
 *
 * 列(クラスタ)の分割は packColumns と同じ「推移的に重なるものを1塊」とする。
 */

export interface OverlapInput {
  id: string;
  startMs: number;
  endMs: number;
  /** true なら背景層。全幅・最背面で、他の予定のレーン計算に参加しない */
  background: boolean;
}

export interface OverlapSlot {
  /** 0〜1。列の左端からの位置 */
  leftFrac: number;
  /** 0〜1。列の幅に対する割合 */
  widthFrac: number;
  /** 描画の重なり順。大きいほど前面。背景層は常に本体より小さい */
  stackIndex: number;
}

/** 同じレーンで乗り合うときの1段あたりのずれ(列幅に対する割合) */
export const STACK_INDENT_FRAC = 0.07;
/** ずらしても予定の幅がこれを下回らないようにする(読める下限) */
const MIN_WIDTH_FRAC = 0.3;

interface Window {
  start: number;
  end: number;
}

function headerWindow(item: OverlapInput, headerMs: number): Window {
  const duration = Math.max(item.endMs - item.startMs, 1);
  return { start: item.startMs, end: item.startMs + Math.min(headerMs, duration) };
}

function windowsOverlap(a: Window, b: Window): boolean {
  return a.start < b.end && b.start < a.end;
}

export function layoutOverlaps(
  items: readonly OverlapInput[],
  headerMs: number,
): Map<string, OverlapSlot> {
  const out = new Map<string, OverlapSlot>();

  // 背景層は先に確定する。stackIndex は 0..(背景数-1) で、本体はその後ろから振る
  const backgrounds = items
    .filter((i) => i.background)
    .sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs);
  backgrounds.forEach((item, rank) => {
    out.set(item.id, { leftFrac: 0, widthFrac: 1, stackIndex: rank });
  });
  const zBase = backgrounds.length;

  const sorted = items
    .filter((i) => !i.background)
    .sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs);

  // 推移的な重なりで塊に分ける
  const clusters: OverlapInput[][] = [];
  let clusterEnd = -Infinity;
  for (const item of sorted) {
    if (clusters.length === 0 || item.startMs >= clusterEnd) {
      clusters.push([]);
      clusterEnd = -Infinity;
    }
    clusters[clusters.length - 1].push(item);
    clusterEnd = Math.max(clusterEnd, item.endMs);
  }

  let z = zBase;
  for (const cluster of clusters) {
    const windows = cluster.map((item) => headerWindow(item, headerMs));

    // レーン割り当て: 見出しの窓が重ならない最初のレーンへ(貪欲 first-fit)
    const laneOf: number[] = [];
    const laneWindowEnd: number[] = [];
    cluster.forEach((_, idx) => {
      const w = windows[idx];
      let lane = laneWindowEnd.findIndex((end) => end <= w.start);
      if (lane === -1) {
        lane = laneWindowEnd.length;
        laneWindowEnd.push(w.end);
      } else {
        laneWindowEnd[lane] = Math.max(laneWindowEnd[lane], w.end);
      }
      laneOf.push(lane);
    });
    const laneCount = laneWindowEnd.length;

    cluster.forEach((item, idx) => {
      const lane = laneOf[idx];

      // 右へ広げる: 見出しの窓が重なる予定のいるレーンの手前まで
      let span = 1;
      for (let k = lane + 1; k < laneCount; k++) {
        const blocked = cluster.some(
          (_, j) => laneOf[j] === k && windowsOverlap(windows[idx], windows[j]),
        );
        if (blocked) break;
        span++;
      }

      // 同じレーンで先に始まり、まだ続いている予定の数だけ右へずらす
      let depth = 0;
      for (let j = 0; j < idx; j++) {
        if (laneOf[j] === lane && cluster[j].endMs > item.startMs) depth++;
      }

      const laneWidth = span / laneCount;
      const maxDepth = Math.max(0, Math.floor((laneWidth - MIN_WIDTH_FRAC) / STACK_INDENT_FRAC));
      const indent = Math.min(depth, maxDepth) * STACK_INDENT_FRAC;

      out.set(item.id, {
        leftFrac: lane / laneCount + indent,
        widthFrac: laneWidth - indent,
        stackIndex: z++,
      });
    });
  }

  return out;
}
