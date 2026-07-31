/**
 * **参加者まわりの2操作 —— 自分の参加ステータス (RSVP) と、ゲスト (参加者) の追加・削除**
 * を担当する (useEventMutations から分割、2026-07-31)。
 *
 * 同居させてあるのは、どちらも「予定の attendees に効く」操作で、
 *  - 非 2xx のうち 422 だけを専用エラー (RsvpNotAttendeeError / GuestNotOrganizerError) に
 *    振り替えて呼び出し側に出し分けさせる
 *  - 時刻予定/終日予定でストアが分かれるだけの書き込み (writeSubject) を共有する
 * という2点をそのまま共有しているため。
 *
 * ただし**流儀は逆**なので注意: RSVP は「保存ボタン方式」(成功してから反映)、
 * ゲスト編集は「楽観更新 + ロールバック」。理由はそれぞれの実装コメントに書いてある。
 */
import { useCallback } from "react";
import type { IDBPDatabase } from "idb";
import type { RsvpResponseStatus } from "@kichijitsu/shared";
import { getOverride, putOverride, type KichijitsuDB } from "../../db/database";
import type { AllDayOccurrence, Occurrence } from "../../model/types";
import type { AllDayStore } from "../../store/allDayStore";
import type { OccurrenceStore } from "../../store/occurrenceStore";
import {
  applyGuestChangesLocally,
  buildEventGuestsRequest,
  GuestNotOrganizerError,
  type GuestChange,
} from "../../sync/eventGuests";
import { buildEventRsvpRequest, RsvpNotAttendeeError } from "../../sync/eventRsvp";
import { sendJson, type CheckedFetch } from "../../sync/httpJson";
import { mergeOverridePatch, resolveOverrideRef } from "../../sync/overridePatch";
import { writeSubject } from "./optimisticWrites";

export function useAttendeeMutations({
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
  rsvp: (subject: Occurrence | AllDayOccurrence, status: RsvpResponseStatus) => Promise<void>;
  editGuests: (subject: Occurrence | AllDayOccurrence, change: GuestChange) => Promise<void>;
} {
  // ---- RSVP (参加ステータス変更、フェーズ2、2026-07-22) ----
  // 編集フォームと同じ「保存ボタン方式」(押した瞬間に楽観反映はしない、await 完了後に反映)。
  // 422 (not_an_attendee) は RsvpNotAttendeeError を reject することで、呼び出し側
  // (EventBlock.tsx の RsvpButtons)が専用メッセージを出し分けられるようにする。
  const rsvp = useCallback(
    async (subject: Occurrence | AllDayOccurrence, status: RsvpResponseStatus): Promise<void> => {
      const req = buildEventRsvpRequest(subject, status);
      if (!req) {
        throw new Error("kichijitsu: could not build EventRsvpRequest");
      }
      // 422 を RsvpNotAttendeeError に振り替える必要があるため、throw する高レベル関数ではなく
      // Response をそのまま受け取る sendJson を使う
      const res = await sendJson(checkedFetch, "POST", "/api/event/rsvp", req);
      if (res.status === 422) {
        throw new RsvpNotAttendeeError();
      }
      if (!res.ok) {
        throw new Error(`kichijitsu: POST /api/event/rsvp failed: ${res.status}`);
      }
      if (!db) return;

      const updated = { ...subject, responseStatus: status };
      await writeSubject(db, { store, allDayStore }, updated);
      if ("startMs" in subject) {
        // シリーズ由来の1回分は override にも参加ステータスを残す(再展開で戻らないように)
        const overrideRef = resolveOverrideRef(subject);
        if (overrideRef) {
          const existing = await getOverride(db, overrideRef.id);
          await putOverride(
            db,
            mergeOverridePatch({ ref: overrideRef, existing, fields: { responseStatus: status } }),
          );
        }
      }
    },
    [db, store, allDayStore, checkedFetch],
  );

  // ---- ゲスト (参加者) の追加・削除 (2026-07-31) ----
  // **楽観更新 + ロールバック** (persist / deleteOccurrence と同じ流儀。RSVP や編集フォームの
  // 「保存ボタン方式」ではない) ―― 押した瞬間に一覧へ行が増える/消えるのが操作の実感そのもので、
  // 往復を待って初めて動くと「押せていないのでは」と何度も押してしまう (= 招待メールが重なる)。
  //
  // ロールバック時に flashSaveError は使わない: この操作の間はゲスト欄が必ず開いており、
  // 詳細カードの中にインラインで理由 (422 は専用メッセージ) を出すほうが近くて正確なため。
  // reject はそのまま呼び出し側 (EventDetailCard の GuestSection) へ伝える。
  //
  // 送るのは**差分だけ**。attendees 配列そのものは送らない ―― 手元の一覧は50件で打ち切られて
  // いることがあり、全置換すると手元に無い参加者を巻き添えで消してしまう (sync/eventGuests.ts)。
  const editGuests = useCallback(
    async (subject: Occurrence | AllDayOccurrence, change: GuestChange): Promise<void> => {
      const req = buildEventGuestsRequest(subject, change);
      if (!req) {
        throw new Error("kichijitsu: could not build EventGuestsRequest");
      }
      // 楽観表示 (サーバーが行う read-modify-write の予測)。db が未オープンなら
      // 見た目だけ先に動かすことはせず、書き込みだけ行う
      const nextAttendees = applyGuestChangesLocally(subject.attendees, change);
      const optimistic = { ...subject, attendees: nextAttendees };
      if (db) {
        await writeSubject(db, { store, allDayStore }, optimistic);
      }

      // 422 を GuestNotOrganizerError に振り替える必要があるため、throw する高レベル関数ではなく
      // Response をそのまま受け取る sendJson を使う (rsvp と同じ)
      const res = await sendJson(checkedFetch, "POST", "/api/event/guests", req);
      if (res.ok) return;

      // ---- ロールバック ----
      if (db) {
        await writeSubject(db, { store, allDayStore }, subject);
      }
      if (res.status === 422) {
        throw new GuestNotOrganizerError();
      }
      throw new Error(`kichijitsu: POST /api/event/guests failed: ${res.status}`);
    },
    [db, store, allDayStore, checkedFetch],
  );

  return { rsvp, editGuests };
}
