/**
 * メニューバー(トレイ)に次の予定を出す配線 (デスクトップ版のみ、2026-11-07)。
 * 判定と文言は sync/trayNextEvent.ts の純関数。ここは、30 秒ごとに store を読み直して、
 * 文言が変わったときだけ Rust へ送る。時間の経過そのものが更新のきっかけなので、
 * useEventReminders と同じく、store の購読ではなく interval で回す。
 */
import { useEffect } from "react";
import type { OccurrenceStore } from "../store/occurrenceStore";
import {
  buildTrayInfo,
  getTrayNextEventEnabled,
  setTrayStatus,
  TRAY_LOOKAHEAD_MS,
} from "../sync/trayNextEvent";

const TICK_MS = 30_000;

export function useTrayNextEvent({
  store,
  timeZone,
  enabled,
}: {
  store: OccurrenceStore | null;
  timeZone: string;
  /** デスクトップ版(Tauri)かどうか。false のときは配線ごと張らない */
  enabled: boolean;
}): void {
  useEffect(() => {
    if (!enabled || !store) return;
    let disposed = false;
    let last = "";

    const tick = () => {
      if (disposed) return;
      const nowMs = Date.now();
      // 設定は毎 tick 読む(設定モーダルは localStorage に直接書く)。オフなら、出したものを消す
      const status = getTrayNextEventEnabled()
        ? buildTrayInfo(store.getRange(nowMs, nowMs + TRAY_LOOKAHEAD_MS), nowMs, timeZone)
        : { title: "", tooltip: "kichijitsu", eventLabels: [], eventStarts: [] };
      const key = JSON.stringify(status);
      if (key === last) return;
      last = key;
      void setTrayStatus(status);
    };

    tick();
    const timer = window.setInterval(tick, TICK_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [store, timeZone, enabled]);
}
