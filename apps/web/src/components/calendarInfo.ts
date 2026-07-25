/**
 * カレンダー名/色の型だけを持つモジュール(リファクタ フェーズ1a、2026-07-25)。
 *
 * なぜ独立させたか: この型は App.tsx・WeekGrid・DayColumn・MonthView・SearchOverlay など
 * 10ファイル以上が使うが、元の定義場所は 1100行超の EventBlock.tsx だった ―― 型1つのために
 * ドラッグ処理・useHourHeight・snap まで抱えたモジュールを import させたくないため、
 * 型だけをここへ移した。既存 import を壊さないよう EventBlock.tsx からは re-export している。
 */

/** カレンダー名/色。App.tsx が calendarsByAccount から `${accountId}:${calendarId}` キーで作る */
export interface CalendarInfo {
  summary: string;
  backgroundColor?: string;
}
