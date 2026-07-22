import type { Occurrence } from "../model/types";
import type { OccurrenceGroup } from "./groupDuplicates";

/**
 * 勤務場所 (workingLocation) レール表示の DOM/React に依存しない純関数層
 * (2026-07-22 終日レーンへ統合 — 全高帯版からの作り直し)。
 *
 * 経緯:
 * 1. 当初 (最初期) は「location フィールドを持つ時間予定」を対象にレール化したが、これは
 *    ユーザーの意図と違った。真意は Google の勤務場所予定
 *    (eventType==='workingLocation'、Occurrence/AllDayOccurrence.isWorkingLocation===true) を
 *    レール表示することだった → location フィールドは一切見ない版に作り直し。
 * 2. その次(点ピン版)は「勤務場所は一点の情報」という判断で開始時刻(または終日は上端固定)
 *    の単一ピンとして表現した。しかしユーザーからは「OOO (不在) のように帯(バー)で表示
 *    したい」という明確な要望があり、時刻予定・終日予定の両方を OOO と同じ
 *    「startMinutes/endMinutes の範囲を持つ帯」として左端レールに描画する版へ作り替えた
 *    (終日は [0, 1440] の全高帯)。
 * 3. しかし終日の勤務場所を左端レールの全高帯にすると「その日いっぱい何も予定が入らない」
 *    誤解を招きやすく、終日レーン(AllDayBar)の他の終日予定(祝日等)と並んで一覧できない
 *    ―― という指摘を受け、終日ぶんだけ終日レーンの通常バー扱いに戻した(このファイルの
 *    2026-07-22 作り直し)。左端レールの帯表示は「時間単位の勤務場所」専用のまま残す
 *    (OOO の時刻予定側と同じ理由 ―― 時間単位の勤務場所は特定の時間帯の情報なので、
 *    タイムライン上に時間軸つきで示す方が分かりやすい)。
 *
 * 終日の勤務場所の扱い: このファイルはもう終日用の split/rail 関数を持たない。WeekGrid.tsx は
 * 終日予定を barGroups から分離せず、他の終日予定と同じく packDayBars → AllDayBar の経路に
 * そのまま流す。AllDayBar.tsx が isWorkingLocation(occurrence) を直接呼んで見た目
 * (`.allday-bar--working-location`)だけを分岐させる ―― 「勤務場所かどうか」の判定基準
 * (isWorkingLocation フラグのみを見る)は時刻・終日で共通のまま、ここに残した1関数を
 * 両方から再利用する。
 *
 * 「location はあるが workingLocation でない普通の予定」はこのレールにも終日の特別扱いにも
 * 出さない(取り違え再発防止、workingLocationRail.test.ts で固定)。
 *
 * OOO との違いは表現の中身(配色・上端の飾り)だけで、形(時間範囲の帯としてレイアウトする
 * こと)は完全に同じにした ―― packColumns の入力から除外する(=カードとして描画しない)点も
 * OOO と同じ(時刻予定側のみ。終日は上記のとおり通常の終日レーン経路)。
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
 * 終日予定は対象外(このファイル冒頭のコメント参照。終日は AllDayBar 側で isWorkingLocation
 * を直接見るだけで、この split を経由しない)。
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
 * DayColumn の勤務場所レールに描画する1本(1帯)ぶんのデータ。oooRail.ts の OooRailItem と
 * 完全に同じ形(startMinutes/endMinutes の範囲)にしてある。時刻予定専用(2026-07-22 終日
 * レーンへ統合 ―― 終日はもうこのレールに出ないため、subject/groupMembers は Occurrence
 * のみに絞ってある。以前は `Occurrence | AllDayOccurrence` の合併型だったが、終日を扱わなく
 * なったことで型からも「終日はここに来ない」ことを保証できるようにした)。
 */
export interface WorkingLocationRailItem {
  /** レール描画・詳細ポップオーバーの React key */
  id: string;
  subject: Occurrence;
  /** 集約グループの全メンバー。EventDetailCard の groupMembers にそのまま渡す */
  groupMembers: Occurrence[];
  /** その日の 0:00 からのオフセット(分) */
  startMinutes: number;
  endMinutes: number;
}

/**
 * 時刻予定の勤務場所 group を [dayStartMs, dayEndMs) にクリップして帯項目化する。
 * oooRail.ts の timedOooRailItems と全く同じロジック ―― 万一日をまたぐ勤務場所が来ても
 * レールが日列の外へはみ出さないよう、開始・終了の両方を日の範囲にクリップする。
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
