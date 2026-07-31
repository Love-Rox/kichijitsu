import { Temporal } from "@js-temporal/polyfill";
import type { View } from "../keyboard/shortcuts";
import { dayRangeMs } from "./dayTime";
import { mondayOf } from "./monthGrid";

/**
 * 「いま選ばれている view」から表示範囲(日数・先頭日・epoch ms 区間)を導く純関数群。
 * もともと App.tsx のコンポーネント外に素で置かれていたものを、DOM/React に触れない層として
 * ここへ移した(dayGrid.ts / monthGrid.ts と同じ流儀。テストで固めるため)。
 *
 * 意図的にここに置いていないもの:
 *  - `isViewAllowedForWidth`(狭幅/広幅で選べる view の判定)は keyboard/shortcuts.ts が唯一の
 *    実装元 ―― ショートカットの view 切替が同じ規則を参照する必要があるため(二重定義を作らない)。
 *  - `initialView`(localStorage 優先で初期 view を決める)は副作用を持つので App.tsx に残す。
 *  - `isPaneMode`(PaneMode の型ガード)は型の定義元である layout/paneMode.ts 側に置いた。
 */

/** localStorage 等の外部由来の文字列が View かどうか(保存値の検証に使う) */
export function isView(value: string): value is View {
  return value === "week" || value === "month" || value === "day3" || value === "day1";
}

/** view ごとの表示日数。'month' は WeekGrid を使わないため呼ばない想定(0を返す) */
export function dayCountForView(view: View): number {
  switch (view) {
    case "week":
      return 7;
    case "day3":
      return 3;
    case "day1":
      return 1;
    case "month":
      return 0;
  }
}

/**
 * 初回マウント時の timelineStart の決め方。week は従来通り「今週の月曜」から始めるが、
 * day3/day1 は「今日」を先頭日にする(月曜始まりにすると、週の後半に開いたときに
 * 過去の日しか見えない/今日が画面外になりうるため、3日/1日タイムラインでは意味がない)。
 *
 * today は既定で実際の現在日。テストから固定日を注入できるよう引数にしてあるだけで、
 * 呼び出し側(App.tsx)は従来どおり view だけを渡す。
 */
export function initialTimelineStart(
  view: View,
  today: Temporal.PlainDate = Temporal.Now.plainDateISO(),
): Temporal.PlainDate {
  return view === "week" ? mondayOf(today) : today;
}

/**
 * [start, start+dayCount日) の epoch ms 範囲(timeZone の壁時計基準)。
 * week/day3/day1 のどのタイムラインビューでも共通で使う(モバイル対応フェーズ2で
 * dayCount=7 固定の weekRangeMs から一般化)。
 *
 * 日境界の計算そのものは layout/dayTime.ts の dayRangeMs に委ねる(2026-07-31、
 * 横断レビュー B-4)。この関数が残っているのは fromMs/toMs という **呼び出し元
 * (ensureExpanded/useOccurrences)の語彙** に合わせるためで、計算の実体ではない。
 */
export function timelineRangeMs(
  start: Temporal.PlainDate,
  dayCount: number,
  timeZone: string,
): { fromMs: number; toMs: number } {
  const { startMs, endMs } = dayRangeMs(start, dayCount, timeZone);
  return { fromMs: startMs, toMs: endMs };
}
