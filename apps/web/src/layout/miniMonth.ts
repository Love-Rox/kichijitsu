import { Temporal } from "@js-temporal/polyfill";
import type { View } from "../keyboard/shortcuts";
import { mondayOf } from "./monthGrid";

/**
 * 左ペインのミニ月カレンダー(左ペイン増分2、2026-07-22)向けの純関数群。
 * 実際の6週×7列の日付グリッド生成そのものは monthGrid.ts の monthGridDays/monthGridWeeks を
 * そのまま再利用する(ここでは重複させない、要件どおり「既存純関数の再利用」)。ここに
 * 置くのはミニカレンダー固有の3つのロジックだけ:
 *   - activeMonthAnchor: メインが今どの月を見ているか(ミニカレンダーの初期表示・追従先)
 *   - isMiniMonthHighlighted: セルをメインの表示範囲として淡くハイライトするか
 *   - resolveMiniMonthNavigation: 日付クリック時に timelineStart/monthCursor のどちらを
 *     どう動かすか(App.tsx のディスパッチはこの結果に従うだけの薄いラッパーにする)
 */

/**
 * メインが現在表示している「月」の代表日(ミニカレンダーの初期表示・追従先を決めるのに使う。
 * 月内のどの日かは呼び出し側は見ない想定 ―― .year/.month だけを比較に使う)。
 * view==='month' は monthCursor(常に月の1日)、タイムラインビュー(week/day3/day1)は
 * timelineStart の属する月をそのまま採用する。
 */
export function activeMonthAnchor(
  view: View,
  timelineStart: Temporal.PlainDate,
  monthCursor: Temporal.PlainDate,
): Temporal.PlainDate {
  return view === "month" ? monthCursor : timelineStart;
}

/**
 * ミニカレンダーの1セル(date)を「メインが今表示中の範囲」として淡くハイライトするか。
 * - タイムラインビュー(week/day3/day1): [timelineStart, timelineStart+dayCount) に入っているか
 * - month ビュー: monthCursor と同じ月かどうか(月表示は月全体が「表示中」であるため、
 *   1日だけでなく月内の全セルをハイライト対象にする ―― タイムラインビューとは意図的に非対称)
 */
export function isMiniMonthHighlighted(
  date: Temporal.PlainDate,
  view: View,
  timelineStart: Temporal.PlainDate,
  dayCount: number,
  monthCursor: Temporal.PlainDate,
): boolean {
  if (view === "month") {
    return date.year === monthCursor.year && date.month === monthCursor.month;
  }
  const offsetDays = timelineStart.until(date, { largestUnit: "days" }).days;
  return offsetDays >= 0 && offsetDays < dayCount;
}

/** ミニカレンダーでの日付クリック時、メインのどの state をどこへ動かすかを表す */
export type MiniMonthNavigationTarget =
  | { kind: "timeline"; date: Temporal.PlainDate }
  | { kind: "month"; date: Temporal.PlainDate };

/**
 * 日付クリック時のナビゲーション先を決める(App.tsx の switchView/goToToday と同じ規則に
 * 揃えてある ―― ミニカレンダーだけ別ルールにすると「今どの週/月を見ているか」の不変条件が
 * 崩れるため):
 * - month 表示中: その日が属する月の1日へ monthCursor を動かす
 * - week 表示中: 週は常に月曜始まりという不変条件があるため、その日を含む週の月曜へ揃える
 *   (mondayOf、goToToday/switchView と同じ規則。クリックした日そのものを timelineStart に
 *   すると週の途中から始まる不整合な状態になってしまう)
 * - day3/day1 表示中: 月曜揃えの概念が無いため、クリックした日をそのまま先頭日にする
 */
export function resolveMiniMonthNavigation(
  view: View,
  date: Temporal.PlainDate,
): MiniMonthNavigationTarget {
  if (view === "month") return { kind: "month", date: date.with({ day: 1 }) };
  if (view === "week") return { kind: "timeline", date: mondayOf(date) };
  return { kind: "timeline", date };
}
