import { Temporal } from "@js-temporal/polyfill";
import type { AllDayOccurrenceGroup } from "./groupDuplicates";
import { packDayBars } from "./packDayBars";

/**
 * 終日レーン(フェーズ5)の派生データ計算を担う純関数層(2026-07-26 リファクタ フェーズ3a
 * で WeekGrid.tsx の3連 useMemo から切り出し)。
 *
 * なぜ切り出したか: 「パネルごとの行割り当て」「3パネルで共有する表示行数」「+N のあふれ」の
 * 3段は互いに順番の依存があり、ズレると終日バーが消える/重なる/高さがパネル間で揃わない
 * という目に見える壊れ方をする。React 描画テストを持たないこのアプリでは、この種のロジックは
 * DOM から切り離して単体テストで固めるのが唯一の担保になる(packDayBars.ts と同じ流儀)。
 *
 * 3段に分かれているのは「共有行数を決めるには全パネルの行割り当てが先に必要」という制約の
 * ためで、この順序自体が仕様である:
 *   1. buildAllDayPanels   … パネルごとに packDayBars して row を確定する(絞り込みはしない)
 *   2. resolveSharedRows   … 全パネルを見て「何行まで見せるか」「+N 行が必要か」を決める
 *   3. clipToVisibleRows   … 確定した行数で可視バーとあふれ(+N)に振り分ける
 */

/** 終日レーンの1本ぶんのバー。row は 0-based(描画側で +1 して CSS grid-row にする) */
export interface RawAllDayBar {
  group: AllDayOccurrenceGroup;
  /** このパネル内の日インデックス [0, dayCount-1] にクリップ済みの開始/終了(両端 inclusive) */
  startDayIndex: number;
  endDayIndex: number;
  /** packDayBars が割り当てた 0-based 行番号 */
  row: number;
}

/** 行割り当てまで済んだ1パネルぶん(まだ表示行数で絞り込んでいない状態) */
export interface RawAllDayPanel {
  panelStart: Temporal.PlainDate;
  bars: RawAllDayBar[];
}

/** 終日レーンの「+N」表示用。非表示になったバーの件数とタイトル一覧(title 属性で列挙する) */
export interface AllDayOverflowInfo {
  count: number;
  titles: string[];
}

/** 表示行数の確定後、実際に描画する形になった1パネルぶん */
export interface AllDayPanel {
  panelStart: Temporal.PlainDate;
  visibleBars: RawAllDayBar[];
  /** 日インデックスごとの「+N」情報。常に dayCount 個ぶん存在する(count===0 の日は描画しない) */
  overflowByDay: AllDayOverflowInfo[];
}

/**
 * パネルごとに、その N 日ぶんのインデックス [0, dayCount-1] にクリップした区間で packDayBars する。
 * 行の割り当てはここで確定するが、「何行まで見せるか」は3パネル分の最大行数を見てから決める
 * (resolveSharedRows)ため、この時点では行を絞り込まない。
 *
 * パネルに 1 日でも掛かる終日予定だけを対象にし(掛からないものは除外)、パネルの外へ伸びる
 * 分は両端をパネル内へクリップする ―― 3週ストリップの各パネルは独立した grid なので、
 * パネル境界をまたぐバーは各パネル側で「端で切れた1本」として描くのが正しい。
 */
export function buildAllDayPanels(
  panelStarts: readonly Temporal.PlainDate[],
  dayCount: number,
  groups: readonly AllDayOccurrenceGroup[],
): RawAllDayPanel[] {
  return panelStarts.map((panelStart) => {
    const panelEndDate = panelStart.add({ days: dayCount - 1 });
    const relevant = groups.filter((g) => {
      const s = Temporal.PlainDate.from(g.primary.startDate);
      const e = Temporal.PlainDate.from(g.primary.endDate);
      return (
        Temporal.PlainDate.compare(s, panelEndDate) <= 0 &&
        Temporal.PlainDate.compare(e, panelStart) >= 0
      );
    });
    const clipped = relevant.map((group) => {
      const s = Temporal.PlainDate.from(group.primary.startDate);
      const e = Temporal.PlainDate.from(group.primary.endDate);
      const startDayIndex = Math.max(0, panelStart.until(s, { largestUnit: "day" }).days);
      const endDayIndex = Math.min(dayCount - 1, panelStart.until(e, { largestUnit: "day" }).days);
      return { group, startDayIndex, endDayIndex };
    });
    const positioned = packDayBars(
      clipped,
      (b) => b.startDayIndex,
      (b) => b.endDayIndex,
    );
    return {
      panelStart,
      bars: positioned.map((p) => ({ ...p.item, row: p.row })),
    };
  });
}

/**
 * 3パネル(prev/current/next)で共有する表示行数を決める。行数が多い日があっても
 * maxVisibleRows 行までしかバーを見せず、それを超える分は「+N」に畳む。3パネルの中で
 * 1パネルでも溢れていれば +N 用の1行を全パネル共通で確保する
 * (パネルごとに高さが変わるとスライドアニメーション中に見た目が揃わないため)。
 */
export function resolveSharedRows(
  panels: readonly RawAllDayPanel[],
  maxVisibleRows: number,
): { visibleRows: number; hasOverflow: boolean } {
  let maxRows = 0;
  let anyOverflow = false;
  for (const panel of panels) {
    for (const bar of panel.bars) {
      maxRows = Math.max(maxRows, bar.row + 1);
      if (bar.row >= maxVisibleRows) anyOverflow = true;
    }
  }
  return {
    visibleRows: Math.min(maxVisibleRows, maxRows),
    hasOverflow: anyOverflow,
  };
}

/**
 * 確定した visibleRows で、各パネルのバーを「そのまま描くもの(visibleBars)」と
 * 「日ごとの +N に畳むもの(overflowByDay)」に振り分ける。
 *
 * 畳まれたバーは自分が掛かる全ての日の件数を増やす ―― 複数日にまたがる1本は、その期間の
 * どの日で見ても「隠れている予定が1件ある」ことになるため(Google カレンダーの月表示と同じ)。
 */
export function clipToVisibleRows(
  panels: readonly RawAllDayPanel[],
  visibleRows: number,
  dayCount: number,
): AllDayPanel[] {
  return panels.map(({ panelStart, bars }) => {
    const visibleBars = bars.filter((b) => b.row < visibleRows);
    const overflowByDay: AllDayOverflowInfo[] = Array.from({ length: dayCount }, () => ({
      count: 0,
      titles: [],
    }));
    for (const b of bars) {
      if (b.row < visibleRows) continue;
      for (let d = b.startDayIndex; d <= b.endDayIndex; d++) {
        overflowByDay[d].count++;
        overflowByDay[d].titles.push(b.group.primary.title);
      }
    }
    return { panelStart, visibleBars, overflowByDay };
  });
}
