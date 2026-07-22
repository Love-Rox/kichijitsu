import { Temporal } from "@js-temporal/polyfill";
import type { AllDayOccurrence, Occurrence } from "../model/types";
import type { AllDayOccurrenceGroup, OccurrenceGroup } from "./groupDuplicates";

/**
 * 勤務場所 (workingLocation) レール表示の DOM/React に依存しない純関数層 (2026-07-22 作り直し)。
 * oooRail.ts と全く同じ流儀(WeekGrid.tsx から呼ばれる薄いロジック層をここへ切り出し、
 * 単体テストしやすくする)で、対象・除外の仕方もほぼそのまま踏襲する。
 *
 * 経緯: 当初 (直前のコミット) は「location フィールドを持つ時間予定」を対象にレール化した
 * が、これはユーザーの意図と違った。真意は「Google の勤務場所予定
 * (eventType==='workingLocation'、Occurrence/AllDayOccurrence.isWorkingLocation===true)」を
 * 不在(OOO)と同じ形でレール表示することだった。このファイルはその作り直し版で、
 * location フィールドは一切見ない ―― 「location はあるが workingLocation でない
 * 普通の予定」はこのレールに出さない(取り違え再発防止、workingLocationRail.test.ts で固定)。
 *
 * OOO との違いは表現形だけ: OOO は時間範囲ぶんの縦バー(占有時間の可視化)だが、勤務場所は
 * 「その日どこで働くか」という一点の情報なので、開始時刻(時刻予定)または日列上端固定
 * (終日予定、要件: 全高バーではなく単一ピン)に置く地図ピン1個で表す。
 * ―― packColumns/packDayBars の入力から除外する(=カードとして描画しない)点は OOO と同じ。
 */

/** Occurrence/AllDayOccurrence 共通の構造的ガード。isWorkingLocation が true の場合のみ勤務場所扱い */
export function isWorkingLocation(target: { isWorkingLocation?: boolean }): boolean {
  return target.isWorkingLocation === true;
}

/**
 * 時刻予定の OccurrenceGroup[] を「通常カード用」と「勤務場所レール用」に振り分ける。
 * 呼び出し元 (WeekGrid.tsx) は既に splitOutOfOfficeGroups で OOO を除いた cardGroups を
 * この関数へ渡し、その結果の cardGroups だけを packColumns(...) に渡すこと ――
 * workingLocationGroups は OOO と同じくカスケード計算(列幅の分割)を一切消費しない。
 */
export function splitWorkingLocationGroups(groups: readonly OccurrenceGroup[]): {
  cardGroups: OccurrenceGroup[];
  workingLocationGroups: OccurrenceGroup[];
} {
  const cardGroups: OccurrenceGroup[] = [];
  const workingLocationGroups: OccurrenceGroup[] = [];
  for (const g of groups) {
    (isWorkingLocation(g.primary) ? workingLocationGroups : cardGroups).push(g);
  }
  return { cardGroups, workingLocationGroups };
}

/**
 * 終日予定版。AllDayBar のチップとしては出さない勤務場所をここで分ける(要件: 全高バーの
 * OOO と違い、終日の勤務場所は日カラム上端の単一ピンとして DayColumn 側に描画する)。
 * 呼び出し元は splitOutOfOfficeAllDayGroups の barGroups をこの関数へ渡すこと。
 */
export function splitWorkingLocationAllDayGroups(groups: readonly AllDayOccurrenceGroup[]): {
  barGroups: AllDayOccurrenceGroup[];
  workingLocationGroups: AllDayOccurrenceGroup[];
} {
  const barGroups: AllDayOccurrenceGroup[] = [];
  const workingLocationGroups: AllDayOccurrenceGroup[] = [];
  for (const g of groups) {
    (isWorkingLocation(g.primary) ? workingLocationGroups : barGroups).push(g);
  }
  return { barGroups, workingLocationGroups };
}

/**
 * DayColumn の勤務場所レールに描画する1本(1ピン)ぶんのデータ。時刻予定・終日予定の
 * どちらの由来かは呼び出し側 (DayColumn.tsx/WorkingLocationRailPin.tsx) が subject の形
 * (startMs の有無) で判別する(oooRail.ts の OooRailItem と同じ考え方)。
 */
export interface WorkingLocationRailItem {
  /** レール描画・詳細ポップオーバーの React key */
  id: string;
  subject: Occurrence | AllDayOccurrence;
  /** 集約グループの全メンバー。EventDetailCard の groupMembers にそのまま渡す */
  groupMembers: (Occurrence | AllDayOccurrence)[];
  /**
   * ピンのその日 0:00 からの縦オフセット(分)。時刻予定は開始時刻、終日予定は常に 0
   * (要件: 全高バーではなく日カラム上端の単一ピン ―― minutesToPx(0) が日カラムの
   * 上端そのものになるので、専用の「固定表示」機構は不要でこの値を持つだけで足りる)。
   */
  topMinutes: number;
}

/**
 * 時刻予定の勤務場所 group を [dayStartMs, dayEndMs) にクリップしてピン化する。
 * ピンは開始時刻1点だけを表すため、oooRail.ts の timedOooRailItems と違い終了側の
 * クリップ(endMinutes)は持たない ―― 日をまたぐ場合は開始側だけ日の 0:00 にクリップする
 * (旧 locationRail.ts の locationRailItems と同じ考え方)。
 */
export function timedWorkingLocationRailItems(
  workingLocationGroups: readonly OccurrenceGroup[],
  dayStartMs: number,
  dayEndMs: number,
): WorkingLocationRailItem[] {
  const out: WorkingLocationRailItem[] = [];
  for (const g of workingLocationGroups) {
    const occ = g.primary;
    if (occ.startMs >= dayEndMs || occ.endMs <= dayStartMs) continue; // この日と無関係
    const clippedStartMs = Math.max(occ.startMs, dayStartMs);
    const topMinutes = (clippedStartMs - dayStartMs) / 60_000;
    out.push({ id: occ.id, subject: occ, groupMembers: g.members, topMinutes });
  }
  return out;
}

/**
 * 終日の勤務場所 group のうち day を含むものを、その日の上端固定ピン(topMinutes: 0)として
 * ピン化する(要件: 終日レーンには出さず、全高バーでもなく、対象日の DayColumn 上端に
 * 単一ピンで出す ―― 毎日出うるため全高バーだと重い、というユーザー判断)。
 */
export function allDayWorkingLocationRailItems(
  workingLocationGroups: readonly AllDayOccurrenceGroup[],
  day: Temporal.PlainDate,
): WorkingLocationRailItem[] {
  const out: WorkingLocationRailItem[] = [];
  for (const g of workingLocationGroups) {
    const occ = g.primary;
    const start = Temporal.PlainDate.from(occ.startDate);
    const end = Temporal.PlainDate.from(occ.endDate);
    if (Temporal.PlainDate.compare(day, start) < 0 || Temporal.PlainDate.compare(day, end) > 0) {
      continue; // day を含まない(startDate〜endDate は両端 inclusive)
    }
    out.push({ id: occ.id, subject: occ, groupMembers: g.members, topMinutes: 0 });
  }
  return out;
}
