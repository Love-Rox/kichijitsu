import { createContext, useContext } from "react";
import { DEFAULT_HOUR_HEIGHT } from "../layout/gridMetrics";

/**
 * 時間軸ズーム(2026-07-25)の「現在の1時間あたり px」を週グリッド配下へ配る context。
 *
 * なぜ context か: minutesToPx/pxToMinutes を必須引数化した結果、日列の中の
 * EventBlock / PlannedBlockCard といった葉のコンポーネントまでズーム値が必要になる。
 * App → WeekGrid → DayColumn → EventBlock と prop で引き回すと、ズームに関係のない
 * 中間コンポーネントの props が増え、渡し忘れも起きやすい ―― そのため「値の供給」だけを
 * context に寄せた。状態の持ち主は従来どおり App.tsx の useState(view/timelineStart と
 * 同じ流儀で localStorage に永続化)で、Provider を張るのは WeekGrid 1箇所だけ。
 *
 * 純モジュール(layout/railStack.ts, sync/planned.ts, sync/mapActivity.ts,
 * sync/mapCiRuns.ts)は context を読まない ―― React に依存させないため、呼び出し側から
 * hourHeight を引数で受け取る形を維持する(テスト可能な純関数のまま)。
 *
 * 既定値は DEFAULT_HOUR_HEIGHT。Provider の外側で useHourHeight() を呼んでも従来の 48px
 * として素直に動く(MonthView など時間軸を持たない画面から誤って読んでも壊れない)。
 */
export const HourHeightContext = createContext<number>(DEFAULT_HOUR_HEIGHT);

/** 現在の1時間あたり px。minutesToPx(minutes, hourHeight) の第2引数に渡す */
export function useHourHeight(): number {
  return useContext(HourHeightContext);
}
