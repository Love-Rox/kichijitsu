import { Temporal } from "@js-temporal/polyfill";
import type { AllDayOccurrence, Occurrence } from "../model/types";
import type { AllDayOccurrenceGroup, OccurrenceGroup } from "./groupDuplicates";
import { railItemsForDay, type RailItem } from "./railItems";

/**
 * 不在 (Out of Office) レール表示 (2026-07-22) の DOM/React に依存しない純関数層。
 * WeekGrid.tsx / MonthView.tsx から呼ばれる薄いロジック層としてここに切り出し、
 * 単体テストしやすくしてある (groupDuplicates.ts/monthGrid.ts と同じ流儀)。
 *
 * 要件: Google の不在予定 (eventType==='outOfOffice', mapGoogle.ts が Occurrence/
 * AllDayOccurrence の isOutOfOffice に写す) は「通常の予定カードとして描画しない」。
 * 代わりに日列端の細いレールへ時間範囲ぶんの縦ラインとして描画する — その振り分けを
 * ここで行う。
 */

/** Occurrence/AllDayOccurrence 共通の構造的ガード。isOutOfOffice が true の場合のみ不在扱い */
export function isOutOfOffice(target: { isOutOfOffice?: boolean }): boolean {
  return target.isOutOfOffice === true;
}

/**
 * 時刻予定の OccurrenceGroup[] を「通常カード用」と「不在レール用」に振り分ける。
 * 呼び出し元 (WeekGrid.tsx) は cardGroups だけを packColumns(cardGroups, ...) に渡すこと
 * — oooGroups はカスケード計算(列幅の分割)を一切消費しない、というのがこの関数の
 * 存在意義そのもの(要件「packColumns への入力から除外する」)。
 */
export function splitOutOfOfficeGroups(groups: readonly OccurrenceGroup[]): {
  cardGroups: OccurrenceGroup[];
  oooGroups: OccurrenceGroup[];
} {
  const cardGroups: OccurrenceGroup[] = [];
  const oooGroups: OccurrenceGroup[] = [];
  for (const g of groups) {
    (isOutOfOffice(g.primary) ? oooGroups : cardGroups).push(g);
  }
  return { cardGroups, oooGroups };
}

/**
 * 終日予定版。AllDayBar のチップとしては出さない不在をここで分ける(要件: 終日の不在は
 * 終日レーンではなく該当日の DayColumn に「その日の全高ライン」として描画する)。
 */
export function splitOutOfOfficeAllDayGroups(groups: readonly AllDayOccurrenceGroup[]): {
  barGroups: AllDayOccurrenceGroup[];
  oooGroups: AllDayOccurrenceGroup[];
} {
  const barGroups: AllDayOccurrenceGroup[] = [];
  const oooGroups: AllDayOccurrenceGroup[] = [];
  for (const g of groups) {
    (isOutOfOffice(g.primary) ? oooGroups : barGroups).push(g);
  }
  return { barGroups, oooGroups };
}

/**
 * DayColumn の不在レールに描画する1本ぶんのデータ。時刻予定・終日予定のどちらの由来かは
 * 呼び出し側 (DayColumn.tsx/RailBand.tsx) が subject の形 (startMs の有無) で判別する
 * (EventDetailCard が両方の形を構造的に受け付けるのと同じ考え方、EventBlock.tsx 参照)。
 *
 * 形そのものは勤務場所レールと共通(layout/railItems.ts の RailItem)で、subject の型だけが
 * 違う ―― 不在は時刻・終日の両方がこのレールに来るため合併型になっている。
 * 終日の不在は常に [0, MINUTES_PER_DAY] (全高) の範囲を持つ。
 */
export type OooRailItem = RailItem<Occurrence | AllDayOccurrence>;

const MINUTES_PER_DAY = 24 * 60;

/**
 * 時刻予定の不在 group を [dayStartMs, dayEndMs) にクリップしてレール項目化する。
 * 計算本体は勤務場所レールと共通の railItemsForDay(layout/railItems.ts)。この薄い
 * ラッパーを残しているのは、呼び出し元 (WeekGrid.tsx) から見て「不在レール用の項目を作る」
 * という意図が名前で読めるようにするため(勤務場所側の対称な関数と対で存在する)。
 */
export function timedOooRailItems(
  oooGroups: readonly OccurrenceGroup[],
  dayStartMs: number,
  dayEndMs: number,
): OooRailItem[] {
  return railItemsForDay(oooGroups, dayStartMs, dayEndMs);
}

/**
 * 終日の不在 group のうち day を含むものを、その日の全高([0, MINUTES_PER_DAY]分)ラインとして
 * レール項目化する(要件: 終日レーンには出さず、対象日の DayColumn に全高ラインで出す)。
 */
export function allDayOooRailItems(
  oooGroups: readonly AllDayOccurrenceGroup[],
  day: Temporal.PlainDate,
): OooRailItem[] {
  const out: OooRailItem[] = [];
  for (const g of oooGroups) {
    const occ = g.primary;
    const start = Temporal.PlainDate.from(occ.startDate);
    const end = Temporal.PlainDate.from(occ.endDate);
    if (Temporal.PlainDate.compare(day, start) < 0 || Temporal.PlainDate.compare(day, end) > 0) {
      continue; // day を含まない(startDate〜endDate は両端 inclusive)
    }
    out.push({
      id: occ.id,
      subject: occ,
      groupMembers: g.members,
      startMinutes: 0,
      endMinutes: MINUTES_PER_DAY,
    });
  }
  return out;
}
