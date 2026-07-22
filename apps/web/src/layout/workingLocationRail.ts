import { Temporal } from "@js-temporal/polyfill";
import type { AllDayOccurrence, Occurrence } from "../model/types";
import type { AllDayOccurrenceGroup, OccurrenceGroup } from "./groupDuplicates";

/**
 * 勤務場所 (workingLocation) レール表示の DOM/React に依存しない純関数層
 * (2026-07-22 帯化 — 点ピン版からの作り直し)。oooRail.ts と全く同じ流儀(WeekGrid.tsx
 * から呼ばれる薄いロジック層をここへ切り出し、単体テストしやすくする)で、対象・除外の
 * 仕方もほぼそのまま踏襲する。
 *
 * 経緯:
 * 1. 当初 (最初期) は「location フィールドを持つ時間予定」を対象にレール化したが、これは
 *    ユーザーの意図と違った。真意は Google の勤務場所予定
 *    (eventType==='workingLocation'、Occurrence/AllDayOccurrence.isWorkingLocation===true) を
 *    レール表示することだった → location フィールドは一切見ない版に作り直し。
 * 2. その次(点ピン版)は「勤務場所は一点の情報」という判断で開始時刻(または終日は上端固定)
 *    の単一ピンとして表現した。しかしユーザーからは「OOO (不在) のように帯(バー)で表示
 *    したい」という明確な要望があり、本ファイルはそれを受けた再作り直し版 ―― OOO の
 *    OooRailItem と全く同じ形(startMinutes/endMinutes の範囲)に変更した。
 *
 * 「location はあるが workingLocation でない普通の予定」はこのレールに出さない
 * (取り違え再発防止、workingLocationRail.test.ts で固定)。
 *
 * OOO との違いは表現の中身(配色・上端の飾り)だけで、形(時間範囲の帯としてレイアウトする
 * こと)は完全に同じにした ―― packColumns/packDayBars の入力から除外する(=カードとして
 * 描画しない)点も OOO と同じ。
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
 * 終日予定版。AllDayBar のチップとしては出さない勤務場所をここで分ける(要件: 終日の
 * 勤務場所も帯化 ―― 終日レーンには出さず、該当日の DayColumn に「その日の全高帯」として
 * 描画する、oooRail.ts の splitOutOfOfficeAllDayGroups と同じ扱い)。
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
 * DayColumn の勤務場所レールに描画する1本(1帯)ぶんのデータ。oooRail.ts の OooRailItem と
 * 完全に同じ形(startMinutes/endMinutes の範囲)にしてある ―― 表現形を OOO と揃えることが
 * このファイルの作り直しの主目的そのもの(帯化、2026-07-22)。時刻予定・終日予定のどちらの
 * 由来かは呼び出し側 (DayColumn.tsx/WorkingLocationRailBand.tsx) が subject の形 (startMs の
 * 有無) で判別する。
 */
export interface WorkingLocationRailItem {
  /** レール描画・詳細ポップオーバーの React key */
  id: string;
  subject: Occurrence | AllDayOccurrence;
  /** 集約グループの全メンバー。EventDetailCard の groupMembers にそのまま渡す */
  groupMembers: (Occurrence | AllDayOccurrence)[];
  /** その日の 0:00 からのオフセット(分)。終日の勤務場所は常に [0, MINUTES_PER_DAY](全高) */
  startMinutes: number;
  endMinutes: number;
}

const MINUTES_PER_DAY = 24 * 60;

/**
 * 時刻予定の勤務場所 group を [dayStartMs, dayEndMs) にクリップして帯項目化する。
 * oooRail.ts の timedOooRailItems と全く同じロジック(帯化により表現形が揃ったため、
 * 実装もそのまま踏襲する)―― 万一日をまたぐ勤務場所が来てもレールが日列の外へ
 * はみ出さないよう、開始・終了の両方を日の範囲にクリップする。
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
    const clippedEndMs = Math.min(occ.endMs, dayEndMs);
    const startMinutes = (clippedStartMs - dayStartMs) / 60_000;
    // 高さ0の帯は見えなくなるので、クリップ後も最低1分ぶんは確保する(oooRail.ts と同じ)
    const endMinutes = Math.max((clippedEndMs - dayStartMs) / 60_000, startMinutes + 1);
    out.push({ id: occ.id, subject: occ, groupMembers: g.members, startMinutes, endMinutes });
  }
  return out;
}

/**
 * 終日の勤務場所 group のうち day を含むものを、その日の全高([0, MINUTES_PER_DAY]分)帯として
 * レール項目化する(帯化、2026-07-22 ―― 従来の「上端固定の単一ピン(topMinutes: 0)」から、
 * OOO の終日不在と同じ「その日いっぱいの帯」に変更した。終日の勤務場所は「その日は
 * ずっとその場所」という情報なので、全高帯のほうが単一ピンより実態に合う)。
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
