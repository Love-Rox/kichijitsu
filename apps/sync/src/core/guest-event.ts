import { NotOrganizerError } from "./errors";
import { applyGuestChanges } from "./guest-edit";
import { parseEventGuestState, patchGuestsRaw } from "../google/guests-raw";
import { updateAttendeesWithRetry, type AttendeeWriteDeps } from "./attendee-write";

/**
 * UserSyncDO.editEventGuests が実装すべき依存先。他の core/*.ts (rsvp-event.ts 等) と
 * 同じ { fetch, getAccessToken, forceRefreshAccessToken } 形なので、DO 側は
 * buildEventWriteDeps を共用できる。
 */
export type GuestEventCoreDeps = AttendeeWriteDeps;

export interface EditGuestsParams {
  calendarId: string;
  eventId: string;
  addEmails?: string[];
  removeEmails?: string[];
}

/**
 * 予定のゲスト (参加者) を追加・削除する (2026-07-31)。
 *
 * `events.patch` の attendees は全置換 (マージではない) なので read-modify-write が必須で、
 * 構造は RSVP (core/rsvp-event.ts) と同じ3段:
 *   1. `events.get` で現在の attendees と `organizer.self` を取得
 *   2. **主催者でなければここで止める** (NotOrganizerError → 422 not_organizer)。
 *      理由は core/errors.ts の NotOrganizerError のコメント参照 ―― 参加者側の複製への
 *      書き込みは主催者に伝わらず、API の結果も公式に定義されていない。
 *   3. 差分 (addEmails/removeEmails) を適用して `events.patch` (sendUpdates=all) で書き戻す
 *
 * 1 と 3 (と 401 リトライ) は RSVP とまったく同じなので core/attendee-write.ts に出してある。
 * **この関数に残っているのは 2 の判断と差分の適用だけ**。
 *
 * **差分を受け取り、配列はサーバーで組む**のがこの経路の要点: クライアントが持つ一覧は
 * MAX_DTO_ATTENDEES (50) 件で打ち切られていることがあり、そのまま全置換すると手元に
 * 無い参加者を巻き添えで全員消してしまう。events.get で読んだ**実際の全員**に対して
 * 差分を当てる (core/guest-edit.ts の applyGuestChanges)。
 *
 * 変更が何も起きない場合 (要求されたアドレスが全て既にいる/居ない、外せない相手だけ) は
 * **patch を送らずに成功として返す** (resolveNext が null を返す) ―― 何も変わらない patch は、
 * それでもゲスト全員へ「予定が更新されました」のメールを飛ばしうる (sendUpdates=all)。
 * 無害な操作で他人の受信箱を鳴らさない。
 */
export async function editEventGuestsWithRetry(
  deps: GuestEventCoreDeps,
  params: EditGuestsParams,
): Promise<void> {
  return updateAttendeesWithRetry(deps, params, {
    patchAttendees: patchGuestsRaw,
    resolveNext: async (response) => {
      const state = await parseEventGuestState(response);
      if (!state.isOrganizer) {
        throw new NotOrganizerError();
      }

      const { next, added, removed } = applyGuestChanges(state.attendees, {
        addEmails: params.addEmails,
        removeEmails: params.removeEmails,
      });
      return added === 0 && removed === 0 ? null : next;
    },
  });
}
