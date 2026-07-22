import type { CalendarListEntryDTO } from "@kichijitsu/shared";

/**
 * 左ペイン(CalendarPane、カレンダーナビゲーション増分1、2026-07-22)の表示振り分けを担う
 * 純関数層(workQueue.ts の groupWorkItemsByKind と同じ考え方)。「選択=左ペイン」の役割分担
 * (ユーザー決定)のもと、アカウント1件ぶんのカレンダー一覧を「マイカレンダー」(自分が
 * owner のカレンダー、primary を含む)と「他のカレンダー」(writer/reader/freeBusyReader、
 * 祝日・購読・同僚のカレンダー等)の2グループへ分ける。
 */
export interface CalendarAccessGroups {
  /** accessRole === "owner"。primary が含まれる場合は必ず先頭 */
  mine: CalendarListEntryDTO[];
  /** owner 以外(writer/reader/freeBusyReader/未設定)。未設定はこちら側に倒す(安全側) */
  others: CalendarListEntryDTO[];
}

/**
 * accessRole は API 取得の失敗やレガシーな (accessRole 導入前の) キャッシュ由来で undefined に
 * なり得る。undefined を「マイカレンダー」に誤分類すると、購読カレンダーが自分のものと
 * 混在してしまい元の課題(混ざって分かりにくい)を再現するため、owner だけを明示的に
 * mine 側に入れ、それ以外は全て others に倒す。
 */
export function groupCalendarsByAccess(calendars: CalendarListEntryDTO[]): CalendarAccessGroups {
  const mine: CalendarListEntryDTO[] = [];
  const others: CalendarListEntryDTO[] = [];
  for (const calendar of calendars) {
    if (calendar.accessRole === "owner") {
      mine.push(calendar);
    } else {
      others.push(calendar);
    }
  }
  // primary を mine の先頭に(Array.prototype.sort は安定ソートなので、primary 以外の
  // 相対順序は元の一覧の並び順のまま保たれる)
  mine.sort((a, b) => Number(!!b.primary) - Number(!!a.primary));
  return { mine, others };
}
