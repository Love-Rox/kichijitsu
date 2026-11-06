import * as Notifications from "expo-notifications";
import { calendarKey } from "@kichijitsu/web/layout/keys";
import {
  isReminderTarget,
  resolveLeadMinutes,
  type CalendarDefaultReminders,
  type ReminderMode,
} from "@kichijitsu/web/sync/reminderSchedule";
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

/** 固定で選べる「何分前」。 */
export const LEAD_OPTIONS = [0, 5, 10, 15, 30] as const;
/** 何分前に通知するか: "google" は、予定ごと(無ければカレンダーごと)の Google の通知設定に従う(既定)。 */
export type ReminderLead = "google" | number;
export const DEFAULT_LEAD: ReminderLead = "google";

export interface NotifySettings {
  enabled: boolean;
  lead: ReminderLead;
}

export async function getNotifySettings(): Promise<NotifySettings> {
  const [enabled, lead] = await Promise.all([getMeta(ENABLED_KEY), getMeta(LEAD_KEY)]);
  const n = Number(lead);
  return {
    enabled: enabled === "1",
    lead: lead === "google" || lead === null || lead === "" ? DEFAULT_LEAD : Number.isFinite(n) ? n : DEFAULT_LEAD,
  };
}

export async function saveNotifySettings(s: NotifySettings): Promise<void> {
  await setMeta(ENABLED_KEY, s.enabled ? "1" : "0");
  await setMeta(LEAD_KEY, String(s.lead));
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

/**
 * 予約の世代。取り消し(ログアウト)や新しい作り直しのたびに進める。世代が古くなった作り直しは、
 * 次の予約を入れる前に止まる。
 */
let generation = 0;
/**
 * 取り消しと作り直しを 1 本の順番待ちにする。ログアウトの取り消しは、進行中の作り直しが止まってから
 * 全消去するので、予約が全消去の後に入ってしまう入れ違いが起きない。止められた作り直しは何も片付けず
 * 抜ける(片付けは、後ろに並んだ取り消し・作り直しが、自分の番の最初に全消去して行う)。
 */
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/** 予約済みの通知をすべて取り消す(ログアウトのとき)。進行中の作り直しも止める。 */
export function cancelAllReminders(): Promise<void> {
  generation++;
  return exclusive(() => Notifications.cancelAllScheduledNotificationsAsync());
}

/** 通知の文言「N 分後」。60 分・1 日で割り切れるときは、時間・日で書く。 */
function leadLabel(lead: number): string {
  if (lead >= 1440 && lead % 1440 === 0) return `${lead / 1440} 日後`;
  if (lead >= 60 && lead % 60 === 0) return `${lead / 60} 時間後`;
  return `${lead} 分後`;
}

/** カレンダーごとの既定の通知(分)。予定側が「既定を使う」のとき、分数はここにしかない。 */
function calendarDefaultsOf(data: CalendarData): CalendarDefaultReminders {
  const map = new Map<string, readonly number[]>();
  for (const a of data.accounts) {
    for (const c of a.all ?? a.calendars) {
      if (c.defaultReminderMinutes) map.set(calendarKey(a.accountId, c.id), c.defaultReminderMinutes);
    }
  }
  return map;
}

/**
 * 予約を作り直す。オフ・未許可なら取り消すだけ。終日・不在・不参加の予定は通知しない。
 * 通知の時刻が過ぎている予定(開始直前に開いたとき等)は、予約しない。
 *
 * 通知のタイミングは、設定が "google" なら予定ごとの通知設定に従う(1 つの予定に複数あれば全部)。
 * Google 側で予定やカレンダーの通知設定が変わると、次の同期で予定のデータが差し替わり、この関数が
 * 呼び直されるので、通知時刻も追随する。設定や予定の値は、毎回ここで読み直す(キャッシュしない)。
 */
export function rescheduleReminders(data: CalendarData, timeZone: string): Promise<number> {
  const gen = ++generation;
  return exclusive(async () => {
    if (gen !== generation) return 0; // 順番待ちの間に、新しい要求や取り消しが入った
    const settings = await getNotifySettings();
    if (gen !== generation) return 0;
    await Notifications.cancelAllScheduledNotificationsAsync();
    if (!settings.enabled) return 0;
    if (!(await Notifications.getPermissionsAsync()).granted) return 0;

    const now = Date.now();
    const mode: ReminderMode =
      settings.lead === "google" ? { kind: "google" } : { kind: "fixed", minutes: settings.lead };
    const defaults = calendarDefaultsOf(data);
    const plan = occurrencesInRange(data, now, now + HORIZON_DAYS * 86_400_000)
      .filter((o) => !o.isOutOfOffice && isReminderTarget(o))
      .flatMap((o) =>
        resolveLeadMinutes(o, mode, defaults)
          .map((lead) => ({ o, lead, fireMs: o.startMs - lead * 60_000 }))
          .filter((p) => p.fireMs > now),
      )
      .sort((a, b) => a.fireMs - b.fireMs)
      .slice(0, MAX_SCHEDULED);

    let count = 0;
    for (const { o, lead, fireMs } of plan) {
      if (gen !== generation) return count; // 後ろの取り消し・作り直しが、全消去から始める
      const when = formatTime(o.startMs, timeZone);
      const where = o.location ? ` ・ ${o.location}` : "";
      const body = lead === 0 ? `${when} 開始${where}` : `${leadLabel(lead)}(${when})${where}`;
      await Notifications.scheduleNotificationAsync({
        content: { title: o.title || "(タイトルなし)", body },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(fireMs) },
      });
      count++;
    }
    return count;
  });
}
