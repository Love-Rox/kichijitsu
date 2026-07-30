/**
 * 予定のリマインダー通知の配線 (デスクトップ版のみ)。
 *
 * 判定は sync/reminderSchedule.ts の純関数、通知の送出は sync/desktopNotify.ts に
 * 分けてあり、このフックは「30 秒ごとに現在時刻で判定し直して、出すべきものを出し、
 * 出したことを記録する」という配線だけを持つ。
 *
 * ## 制約 (ドキュメントにも同じことを書いている)
 * アプリのプロセスが動いている間だけ通知が出る。トレイ常駐アプリなのでウィンドウの
 * 「閉じる」ではプロセスは終わらず (lib.rs の CloseRequested は prevent_close + hide)、
 * 隠したままでも通知は続くが、トレイメニューの「終了」でアプリを終わらせている間は
 * 出ない。リモート URL 方式で Rust 側に予定データが無いため、アプリ未起動でも通知する
 * には Rust 側に予定を持たせるか Web Push が必要で、そこは今回の範囲外
 * (sync/reminderSchedule.ts 冒頭コメント参照)。
 *
 * ## なぜ store の購読ではなく interval なのか
 * 時間の経過そのものが判定のトリガーなので、予定データの変化を購読しても足りない
 * (何も変わらなくても 10 分前は来る)。逆に interval だけあれば、同期で予定が
 * 増減・移動しても次の tick が最新の store を読み直すので追随できる。
 */

import { useEffect } from "react";
import type { OccurrenceStore } from "../store/occurrenceStore";
import { notifyNatively } from "../sync/desktopNotify";
import {
  getNotifiedKeys,
  getReminderMode,
  pruneNotifiedKeys,
  REMINDER_LOOKAHEAD_MS,
  REMINDER_TICK_MS,
  selectDueReminders,
  setNotifiedKeys,
  type CalendarDefaultReminders,
} from "../sync/reminderSchedule";

export interface UseEventRemindersOptions {
  /** 時刻付き予定の読み口。null (初期化前) の間は何もしない */
  store: OccurrenceStore | null;
  /** 通知の本文で開始時刻を表示するタイムゾーン */
  timeZone: string;
  /** デスクトップ版 (Tauri) かどうか。false のときは配線ごと張らない */
  enabled: boolean;
  /**
   * カレンダーごとの既定リマインダー (2026-07-31)。予定側が `{ useDefault: true }` の
   * ときの分数はここにしか無い (CalendarListEntryDTO.defaultReminderMinutes)。
   * カレンダー一覧の取得より先に tick が走ることがあるので、空でも動くこと。
   */
  calendarDefaults: CalendarDefaultReminders;
}

export function useEventReminders({
  store,
  timeZone,
  enabled,
  calendarDefaults,
}: UseEventRemindersOptions): void {
  useEffect(() => {
    if (!enabled || !store) return;

    let disposed = false;

    const tick = () => {
      if (disposed) return;

      // 設定は毎 tick 読む。設定モーダル側は localStorage に直接書く流儀 (ThemeControl と
      // 同じ) なので、変更を伝える経路はこれで足りる ―― 次の tick から新しい設定で動く。
      const mode = getReminderMode();
      if (mode.kind === "off") return;

      const nowMs = Date.now();
      const candidates = store.getRange(nowMs, nowMs + REMINDER_LOOKAHEAD_MS);
      const notified = getNotifiedKeys();
      const due = selectDueReminders({
        candidates,
        nowMs,
        mode,
        calendarDefaults,
        notified,
        timeZone,
      });

      // 通知済み記録は「出そうとした時点」で先に確定させる。通知の送出は非同期なので、
      // await してから記録すると、その間に次の tick が同じ予定をもう一度拾ってしまう。
      // 送出に失敗しても再送はしない(黙って同じ通知を連投するより静かに落とす方がまし)。
      const next = pruneNotifiedKeys(notified, nowMs);
      for (const reminder of due) next.add(reminder.key);
      // 中身が変わった tick だけ書き戻す。30 秒ごとに無条件で書くと、何も起きていない
      // 大多数の tick でも localStorage への書き込みが走ってしまう。
      if (next.size !== notified.size || due.length > 0) setNotifiedKeys(next);

      for (const reminder of due) {
        void notifyNatively(reminder.title, reminder.body);
      }
    };

    // 起動直後にも一度判定する(30 秒待たない)。
    tick();
    const timer = window.setInterval(tick, REMINDER_TICK_MS);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [store, timeZone, enabled, calendarDefaults]);
}
