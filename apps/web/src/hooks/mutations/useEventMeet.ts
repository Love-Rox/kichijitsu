/**
 * **既存の予定に Google Meet を追加する**(詳細カードのボタン)。useEventMutations から呼ばれる。
 *
 * 流儀は RSVP・色の変更と同じ「保存ボタン方式」: POST /api/event/meet が成功してから、手元
 * (store と IndexedDB)へ反映する。Google が会議を作るまでに少し時間がかかるので、押した瞬間に
 * リンクが出る楽観更新は嘘になる。サーバーが URL を返したときだけ、その予定にリンクを書く
 * (返さなかった = Google がまだ作っている途中。次の同期でリンクが入る)。
 * 繰り返しの予定はシリーズ全体に付く(手元で更新するのは、操作した回だけ。ほかの回は同期で入る)。
 */
import { useCallback } from "react";
import type { IDBPDatabase } from "idb";
import type { EventMeetResponse } from "@kichijitsu/shared";
import { getOverride, putOverride, type KichijitsuDB } from "../../db/database";
import type { Occurrence } from "../../model/types";
import type { AllDayStore } from "../../store/allDayStore";
import type { OccurrenceStore } from "../../store/occurrenceStore";
import { buildEventMeetRequest } from "../../sync/eventMeet";
import { sendJson, type CheckedFetch } from "../../sync/httpJson";
import { mergeOverridePatch, resolveOverrideRef } from "../../sync/overridePatch";
import { writeSubject } from "./optimisticWrites";

export function useEventMeet({
  db,
  store,
  allDayStore,
  checkedFetch,
}: {
  db: IDBPDatabase<KichijitsuDB> | null;
  store: OccurrenceStore;
  allDayStore: AllDayStore;
  checkedFetch: CheckedFetch;
}): { addMeet: (subject: Occurrence) => Promise<void> } {
  const addMeet = useCallback(
    async (subject: Occurrence): Promise<void> => {
      const req = buildEventMeetRequest(subject);
      if (!req) {
        throw new Error("kichijitsu: could not build EventMeetRequest");
      }
      const res = await sendJson(checkedFetch, "POST", "/api/event/meet", req);
      if (!res.ok) {
        throw new Error(`kichijitsu: POST /api/event/meet failed: ${res.status}`);
      }
      const body = (await res.json().catch(() => undefined)) as EventMeetResponse | undefined;
      const conferenceUrl = body?.conferenceUrl;
      if (!db || !conferenceUrl) return;

      const patch = { conferenceUrl, hasConference: true };
      await writeSubject(db, { store, allDayStore }, { ...subject, ...patch });
      // シリーズ由来の1回分は override にも残す(再展開で、リンクの無い状態に戻らないように)
      const overrideRef = resolveOverrideRef(subject);
      if (overrideRef) {
        const existing = await getOverride(db, overrideRef.id);
        await putOverride(db, mergeOverridePatch({ ref: overrideRef, existing, fields: patch }));
      }
    },
    [db, store, allDayStore, checkedFetch],
  );

  return { addMeet };
}
