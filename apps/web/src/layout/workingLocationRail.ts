import { Temporal } from "@js-temporal/polyfill";
import type { AllDayOccurrence, Occurrence } from "../model/types";
import type { AllDayOccurrenceGroup, OccurrenceGroup } from "./groupDuplicates";
import { railItemsForDay, type RailItem } from "./railItems";
import { MINUTES_PER_DAY } from "./workingLocationSegments";

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
 * 4. 2026-07-29「1日の区間として描く」。3 の形は「同じ日に終日と時刻付きが両方ある」日で
 *    破綻していた ―― 終日はチップ、時刻付きは帯として **独立に** 並ぶので、利用者からは
 *    「勤務地の変更前と変更後の両方が残っている」ように見えていた。実際には Google の
 *    勤務場所モデルどおり「その日の既定の場所(終日)」と「一部の時間帯だけ別の場所
 *    (時刻付き)」が併存しているのが正しいデータで、Google カレンダー自身は1日を区間に
 *    分割して描く。そこで **時刻付きがある日だけ** 終日ぶんもレール側へ回し、
 *    layout/workingLocationSegments.ts で1日ぶんの区間列へ畳んでから描くようにした。
 *
 * 終日の勤務場所の扱い(4 以降): 「その日に時刻付きの勤務場所があるか」で行き先が2つに分かれる。
 * - 時刻付きが1件も無い日 … 3 のまま。barGroups に残し、packDayBars → AllDayBar の通常経路で
 *   チップとして出す(AllDayBar.tsx が isWorkingLocation(occurrence) を直接呼んで見た目だけを
 *   分岐させる)。**既存利用者の見え方を変えないため、この経路は意図的に据え置いてある。**
 * - 時刻付きがある日 … 終日ぶんもレールへ回し(allDayWorkingLocationBaseItems)、時刻付きと
 *   合わせて区間列へ畳む。この日は終日チップを出さない ―― それが二重表示の直接の原因だった。
 * 振り分けは splitWorkingLocationAllDayGroups が行う。「勤務場所かどうか」の判定基準
 * (isWorkingLocation フラグのみを見る)は時刻・終日で共通のまま、ここに残した1関数を
 * 各所から再利用する。
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
 * 終日の勤務場所 group を「終日レーンのチップとして出すもの」と「レールの区間の地にするもの」に
 * 振り分ける(2026-07-29「1日の区間として描く」)。
 *
 * 判定は日単位: その終日予定が掛かる日のうち **1日でも** 時刻付きの勤務場所がある日があれば
 * 区間側 (segmentGroups) へ回す。日ごとに切り替えないのは、終日レーンのバーが複数日を1本の
 * CSS grid 要素でまたぐ作りで「途中の1日だけチップを消す」ことが構造的にできないため ――
 * 無理に分けると同じ予定がチップと帯に分裂して見え、今回直したかった二重表示に逆戻りする。
 *
 * 実データではこの妥協はまず表面化しない。Google 公式ガイド
 * (https://developers.google.com/workspace/calendar/api/guides/calendar-status) は
 * "All-day working location events cannot span multiple days" と明記していて、終日の勤務場所は
 * 必ず1日ぶんだからである(複数日にまたがる形は「別カレンダーから来た手書きデータ」等の
 * 想定外入力でしか起こらない)。それでも壊れないよう、掛かる全日を見る形にしてある。
 *
 * datesWithTimedWorkingLocation は "YYYY-MM-DD"(Temporal.PlainDate.toString() と同じ表記)の
 * 集合。呼び出し元 (WeekGrid.tsx) が表示中の各日について「時刻付きの勤務場所が1件以上あるか」を
 * 数えて渡す ―― 日の境界はタイムゾーン依存なので、その判定はここではなく日割りを持つ側の仕事。
 *
 * 勤務場所でない終日予定(祝日・不在など)は素通しで barGroups に残る。不在 (OOO) の
 * 置き場所設定 (layout/oooAllDayPlacement.ts) とは独立 ―― eventType は排他なので、
 * 同じ occurrence が isOutOfOffice と isWorkingLocation の両方で true になることはない。
 */
export function splitWorkingLocationAllDayGroups(
  groups: readonly AllDayOccurrenceGroup[],
  datesWithTimedWorkingLocation: ReadonlySet<string>,
): {
  barGroups: AllDayOccurrenceGroup[];
  segmentGroups: AllDayOccurrenceGroup[];
} {
  const barGroups: AllDayOccurrenceGroup[] = [];
  const segmentGroups: AllDayOccurrenceGroup[] = [];
  for (const g of groups) {
    (isWorkingLocation(g.primary) && coversAnyDate(g.primary, datesWithTimedWorkingLocation)
      ? segmentGroups
      : barGroups
    ).push(g);
  }
  return { barGroups, segmentGroups };
}

/** 終日予定の startDate〜endDate(両端 inclusive)に dates のいずれかが含まれるか */
function coversAnyDate(occ: AllDayOccurrence, dates: ReadonlySet<string>): boolean {
  const end = Temporal.PlainDate.from(occ.endDate);
  for (
    let d = Temporal.PlainDate.from(occ.startDate);
    Temporal.PlainDate.compare(d, end) <= 0;
    d = d.add({ days: 1 })
  ) {
    if (dates.has(d.toString())) return true;
  }
  return false;
}

/**
 * DayColumn の勤務場所レールに描画する1本(1区間)ぶんのデータ。oooRail.ts の OooRailItem と
 * 完全に同じ形(layout/railItems.ts の RailItem)。
 *
 * subject は時刻予定 (Occurrence) と終日予定 (AllDayOccurrence) の合併型
 * (2026-07-29「1日の区間として描く」で、終日ぶんが地としてこのレールへ戻ってきたため。
 * 2026-07-22〜2026-07-29 の間だけ Occurrence 限定だった)。ラベル整形の分岐は RailBand.tsx が
 * subject の形 (startMs の有無) で行う ―― OOO 側と全く同じ扱い。
 */
export type WorkingLocationRailItem = RailItem<Occurrence | AllDayOccurrence>;

/**
 * 時刻予定の勤務場所 group を [dayStartMs, dayEndMs) にクリップして帯項目化する。
 * 計算本体は OOO レールと共通の railItemsForDay(layout/railItems.ts、2026-07-26 に
 * 「oooRail.ts の timedOooRailItems と全く同じロジック」だったものを generic 化して統合)。
 * このラッパーは呼び出し元 (WeekGrid.tsx) 側の意図を名前で示すために残してある。
 */
export function timedWorkingLocationRailItems(
  workingLocationGroups: readonly OccurrenceGroup[],
  dayStartMs: number,
  dayEndMs: number,
): WorkingLocationRailItem[] {
  return railItemsForDay(workingLocationGroups, dayStartMs, dayEndMs);
}

/**
 * 終日の勤務場所 group のうち day を含むものを、その日の「地」(全日 [0, MINUTES_PER_DAY] の
 * 区間)としてレール項目化する(2026-07-29「1日の区間として描く」)。形は
 * oooRail.ts の allDayOooRailItems と同じ ―― 違うのは、この結果がそのまま帯として描かれるの
 * ではなく、foldWorkingLocationDay で時刻付きの区間に上書きされてから描かれる点だけ。
 *
 * 渡す group は splitWorkingLocationAllDayGroups の segmentGroups(= その日に時刻付きの
 * 勤務場所がある日の終日ぶん)に限ること。時刻付きが無い日の終日ぶんまでここへ回すと、
 * 従来チップだったものが全高の帯に変わって既存利用者の見え方を壊す。
 */
export function allDayWorkingLocationRailItems(
  segmentGroups: readonly AllDayOccurrenceGroup[],
  day: Temporal.PlainDate,
): WorkingLocationRailItem[] {
  const out: WorkingLocationRailItem[] = [];
  for (const g of segmentGroups) {
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
