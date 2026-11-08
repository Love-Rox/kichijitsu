import { ExtensionStorage } from "@bacons/apple-targets";
import { occurrencesInRange, type CalendarData } from "./calendarData";
import { ACCENTS, type AccentKey } from "./accents";
import { DEFAULT_WIDGET_FILTERS, type WidgetFilters } from "./widgetFilters";
import { sendToWatch } from "../../modules/kichijitsu-watch";

/**
 * ホーム画面のウィジェット(targets/widget)へ、直近の予定を渡す。App Group の UserDefaults に
 * JSON を書き、ウィジェットの再読み込みを依頼する。ウィジェットはロック画面やホーム画面に出るので、
 * ログアウトでは必ず clearWidget() で消す。
 *
 * Apple Watch(targets/watch)にも、同じ内容を送る。Watch は別の端末で App Group を共有できないので、
 * WatchConnectivity(modules/kichijitsu-watch)で、同じキー("events" / "theme")・同じ JSON を届ける。
 * 届くのは「最新の 1 通」だけなので、予定とテーマは、まとめて持っておいて、毎回両方を送る。
 */
const APP_GROUP = "group.cc.love-rox.kichijitsu";
const KEY = "events";
const HORIZON_DAYS = 7;
const MAX_EVENTS = 12;

const storage = new ExtensionStorage(APP_GROUP);

/** Watch へ送る最新の内容(予定とテーマ)。片方だけ変わったときも、もう片方を落とさないために持つ。 */
const watchContext: Record<string, string> = {};

function writeShared(key: string, json: string): void {
  storage.set(key, json);
  watchContext[key] = json;
  sendToWatch(watchContext);
}

/** 予定が属するカレンダーの名前と色。見つからなければ undefined。 */
function calendarOf(
  data: CalendarData,
  accountId?: string,
  calendarId?: string,
): { name: string; color?: string } | undefined {
  for (const a of data.accounts) {
    if (a.accountId !== accountId) continue;
    const cal = (a.all ?? a.calendars).find((c) => c.id === calendarId);
    return cal ? { name: cal.summary, color: cal.backgroundColor } : undefined;
  }
  return undefined;
}

/**
 * 終わっていない予定を、開始順に最大 MAX_EVENTS 件。不参加は含めない。不在と勤務場所の予定は、
 * 設定(filters)で含めるかを選ぶ。
 */
export function updateWidget(data: CalendarData, filters: WidgetFilters = DEFAULT_WIDGET_FILTERS): void {
  const now = Date.now();
  const events = occurrencesInRange(data, now, now + HORIZON_DAYS * 86_400_000)
    .filter(
      (o) =>
        (filters.outOfOffice || !o.isOutOfOffice) &&
        (filters.workingLocation || !o.isWorkingLocation) &&
        o.responseStatus !== "declined" &&
        o.endMs > now,
    )
    .slice(0, MAX_EVENTS)
    .map((o) => {
      const cal = calendarOf(data, o.accountId, o.calendarId);
      return {
        title: o.title || "(タイトルなし)",
        startMs: o.startMs,
        endMs: o.endMs,
        color: o.color,
        // Watch の詳細に出す(ウィジェットは使わない)
        location: o.location || undefined,
        calendar: cal?.name,
        calendarColor: cal?.color,
      };
    });
  writeShared(KEY, JSON.stringify({ updatedAt: now, events }));
  ExtensionStorage.reloadWidget();
}

/**
 * アプリのアクセント色を、ウィジェットへ渡す(ライト用・ダーク用の組)。ウィジェットの明暗は OS に従うので、
 * 両方を渡す。予定の内容ではないので、ログアウトでは消さない。
 */
export function writeWidgetTheme(accent: AccentKey): void {
  const c = ACCENTS[accent];
  writeShared("theme", JSON.stringify({ light: c.light.accent, dark: c.dark.accent }));
  ExtensionStorage.reloadWidget();
}

/** ウィジェットの予定を消す(ログアウトのとき)。 */
export function clearWidget(): void {
  writeShared(KEY, JSON.stringify({ updatedAt: Date.now(), events: [] }));
  ExtensionStorage.reloadWidget();
}
