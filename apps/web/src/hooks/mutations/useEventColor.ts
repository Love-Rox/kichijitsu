/**
 * **予定の色の変更**(詳細カードの色の選択)。useEventMutations から呼ばれる。
 *
 * 流儀は RSVP と同じ「保存ボタン方式」: POST /api/event/color が成功してから、手元(store と
 * IndexedDB)へ反映する。色の変更は楽観更新の実感が要る操作ではなく、失敗したときに色が元へ戻る
 * ちらつきのほうが紛らわしいため。ゲストへのメールは出ない(色は見た目の属性。サーバーが
 * sendUpdates=none で書く)。
 *
 * 繰り返しの予定は「この回だけ」の色を変える(Google のインスタンスに colorId を書く)。手元でも
 * その回の override に色を残し、再展開でシリーズ側の色に戻らないようにする。
 */
import { useCallback } from "react";
import type { IDBPDatabase } from "idb";
import { getOverride, putOverride, type KichijitsuDB } from "../../db/database";
import { EVENT_COLORS } from "../../layout/eventColorChoices";
import type { AllDayOccurrence, Occurrence } from "../../model/types";
import type { AllDayStore } from "../../store/allDayStore";
import type { OccurrenceStore } from "../../store/occurrenceStore";
import { buildEventColorRequest } from "../../sync/eventColor";
import { sendJson, type CheckedFetch } from "../../sync/httpJson";
import { mergeOverridePatch, resolveOverrideRef } from "../../sync/overridePatch";
import { writeSubject } from "./optimisticWrites";

export function useEventColor({
  db,
  store,
  allDayStore,
  checkedFetch,
}: {
  db: IDBPDatabase<KichijitsuDB> | null;
  store: OccurrenceStore;
  allDayStore: AllDayStore;
  checkedFetch: CheckedFetch;
}): {
  /**
   * colorId は Google のイベント色("1".."11")。null は予定個別の色を外す(カレンダーの色に戻す)。
   * calendarColor は、外したときに表示する、その予定が属するカレンダーの色(呼び出し側が知っている)。
   */
  setColor: (
    subject: Occurrence | AllDayOccurrence,
    colorId: string | null,
    calendarColor: string,
  ) => Promise<void>;
} {
  const setColor = useCallback(
    async (
      subject: Occurrence | AllDayOccurrence,
      colorId: string | null,
      calendarColor: string,
    ): Promise<void> => {
      const req = buildEventColorRequest(subject, colorId);
      if (!req) {
        throw new Error("kichijitsu: could not build EventColorRequest");
      }
      const res = await sendJson(checkedFetch, "POST", "/api/event/color", req);
      if (!res.ok) {
        throw new Error(`kichijitsu: POST /api/event/color failed: ${res.status}`);
      }
      if (!db) return;

      const hex = colorId ? EVENT_COLORS.find((c) => c.id === colorId)?.hex : calendarColor;
      const patch = { color: hex ?? calendarColor, hasCustomColor: colorId !== null };
      await writeSubject(db, { store, allDayStore }, { ...subject, ...patch });
      if ("startMs" in subject) {
        // シリーズ由来の1回分は override にも色を残す(再展開で戻らないように)
        const overrideRef = resolveOverrideRef(subject);
        if (overrideRef) {
          const existing = await getOverride(db, overrideRef.id);
          await putOverride(db, mergeOverridePatch({ ref: overrideRef, existing, fields: patch }));
        }
      }
    },
    [db, store, allDayStore, checkedFetch],
  );

  return { setColor };
}
