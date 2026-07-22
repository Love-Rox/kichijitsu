import { Temporal } from "@js-temporal/polyfill";
import type { AllDayOccurrence, Occurrence } from "../model/types";
import type { AllDayOccurrenceGroup, OccurrenceGroup } from "./groupDuplicates";

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
 * 呼び出し側 (DayColumn.tsx/OooRailLine.tsx) が subject の形 (startMs の有無) で判別する
 * (EventDetailCard が両方の形を構造的に受け付けるのと同じ考え方、EventBlock.tsx 参照)。
 */
export interface OooRailItem {
  /** レール描画・詳細ポップオーバーの React key */
  id: string;
  subject: Occurrence | AllDayOccurrence;
  /** 集約グループの全メンバー。EventDetailCard の groupMembers にそのまま渡す */
  groupMembers: (Occurrence | AllDayOccurrence)[];
  /** その日の 0:00 からのオフセット(分)。終日の不在は常に [0, MINUTES_PER_DAY] (全高) */
  startMinutes: number;
  endMinutes: number;
}

const MINUTES_PER_DAY = 24 * 60;

/**
 * 時刻予定の不在 group を [dayStartMs, dayEndMs) にクリップしてレール項目化する。
 * 呼び出し元 (WeekGrid.tsx) は既にその日ぶんに絞り込んだ occurrence だけを渡す前提
 * (通常の時刻予定と同じ日別フィルタを経由済み)なので通常はクリップは効かないが、
 * 万一日をまたぐ不在が来てもレールが日列の外へはみ出さないよう保険をかけておく。
 */
export function timedOooRailItems(
  oooGroups: readonly OccurrenceGroup[],
  dayStartMs: number,
  dayEndMs: number,
): OooRailItem[] {
  const out: OooRailItem[] = [];
  for (const g of oooGroups) {
    const occ = g.primary;
    if (occ.startMs >= dayEndMs || occ.endMs <= dayStartMs) continue; // この日と無関係
    const clippedStartMs = Math.max(occ.startMs, dayStartMs);
    const clippedEndMs = Math.min(occ.endMs, dayEndMs);
    const startMinutes = (clippedStartMs - dayStartMs) / 60_000;
    // 高さ0のラインは見えなくなるので、クリップ後も最低1分ぶんは確保する
    const endMinutes = Math.max((clippedEndMs - dayStartMs) / 60_000, startMinutes + 1);
    out.push({ id: occ.id, subject: occ, groupMembers: g.members, startMinutes, endMinutes });
  }
  return out;
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
