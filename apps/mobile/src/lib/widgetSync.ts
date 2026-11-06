import { ExtensionStorage } from "@bacons/apple-targets";
import { occurrencesInRange, type CalendarData } from "./calendarData";

/**
 * ホーム画面のウィジェット(targets/widget)へ、直近の予定を渡す。App Group の UserDefaults に
 * JSON を書き、ウィジェットの再読み込みを依頼する。ウィジェットはロック画面やホーム画面に出るので、
 * ログアウトでは必ず clearWidget() で消す。
 */
const APP_GROUP = "group.cc.love-rox.kichijitsu";
const KEY = "events";
const HORIZON_DAYS = 7;
const MAX_EVENTS = 12;

const storage = new ExtensionStorage(APP_GROUP);

/** 終わっていない予定を、開始順に最大 MAX_EVENTS 件。終日・不在・不参加は含めない(通知と同じ)。 */
export function updateWidget(data: CalendarData): void {
  const now = Date.now();
  const events = occurrencesInRange(data, now, now + HORIZON_DAYS * 86_400_000)
    .filter((o) => !o.isOutOfOffice && o.responseStatus !== "declined" && o.endMs > now)
    .slice(0, MAX_EVENTS)
    .map((o) => ({
      title: o.title || "(タイトルなし)",
      startMs: o.startMs,
      endMs: o.endMs,
      color: o.color,
    }));
  storage.set(KEY, JSON.stringify({ updatedAt: now, events }));
  ExtensionStorage.reloadWidget();
}

/** ウィジェットの予定を消す(ログアウトのとき)。 */
export function clearWidget(): void {
  storage.set(KEY, JSON.stringify({ updatedAt: Date.now(), events: [] }));
  ExtensionStorage.reloadWidget();
}
