import * as Notifications from "expo-notifications";
import { occurrencesInRange, type CalendarData } from "./calendarData";
import { getMeta, setMeta } from "./localDb";
import { formatTime } from "./format";

/**
 * 予定の開始通知。サーバーからのプッシュは使わず、手元(SQLite)の予定から、この端末の
 * ローカル通知を予約する。同期や前面復帰のたびに、予約を丸ごと作り直す。
 * iOS は予約できる通知が 64 件までなので、直近の予定から順に MAX_SCHEDULED 件だけ入れる。
 */
const MAX_SCHEDULED = 60;
/** 何日先までの予定を予約するか。 */
const HORIZON_DAYS = 14;
const ENABLED_KEY = "notifyEnabled";
const LEAD_KEY = "notifyLeadMinutes";

export const LEAD_OPTIONS = [0, 5, 10, 15, 30] as const;
export const DEFAULT_LEAD_MINUTES = 10;

export interface NotifySettings {
  enabled: boolean;
  leadMinutes: number;
}

export async function getNotifySettings(): Promise<NotifySettings> {
  const [enabled, lead] = await Promise.all([getMeta(ENABLED_KEY), getMeta(LEAD_KEY)]);
  const n = Number(lead);
  return {
    enabled: enabled === "1",
    leadMinutes: lead !== null && lead !== "" && Number.isFinite(n) ? n : DEFAULT_LEAD_MINUTES,
  };
}

export async function saveNotifySettings(s: NotifySettings): Promise<void> {
  await setMeta(ENABLED_KEY, s.enabled ? "1" : "0");
  await setMeta(LEAD_KEY, String(s.leadMinutes));
}

/** アプリが前面にあるときも、通知をバナーで見せる。起動時に 1 回呼ぶ。 */
export function installNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/** 通知の許可を求める(未決定のときだけ表示される)。許可されていれば true。 */
export async function ensureNotifyPermission(): Promise<boolean> {
  const cur = await Notifications.getPermissionsAsync();
  if (cur.granted) return true;
  if (!cur.canAskAgain) return false;
  const next = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true } });
  return next.granted;
}

/** 予約済みの通知をすべて取り消す(オフにしたとき、ログアウトのとき)。 */
export async function cancelAllReminders(): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync();
}

/**
 * 予約を作り直す。オフ・未許可なら取り消すだけ。終日・不在・不参加の予定は通知しない。
 * 通知の時刻が過ぎている予定(開始直前に開いたとき等)は、予約しない。
 */
export async function rescheduleReminders(data: CalendarData, timeZone: string): Promise<number> {
  const settings = await getNotifySettings();
  await Notifications.cancelAllScheduledNotificationsAsync();
  if (!settings.enabled) return 0;
  if (!(await Notifications.getPermissionsAsync()).granted) return 0;

  const now = Date.now();
  const leadMs = settings.leadMinutes * 60_000;
  const upcoming = occurrencesInRange(data, now, now + HORIZON_DAYS * 86_400_000)
    .filter((o) => !o.isOutOfOffice && o.responseStatus !== "declined" && o.startMs - leadMs > now)
    .slice(0, MAX_SCHEDULED);

  for (const o of upcoming) {
    const when = formatTime(o.startMs, timeZone);
    const body =
      settings.leadMinutes === 0
        ? `${when} 開始${o.location ? ` ・ ${o.location}` : ""}`
        : `${settings.leadMinutes} 分後(${when})${o.location ? ` ・ ${o.location}` : ""}`;
    await Notifications.scheduleNotificationAsync({
      content: { title: o.title || "(タイトルなし)", body },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(o.startMs - leadMs) },
    });
  }
  return upcoming.length;
}
