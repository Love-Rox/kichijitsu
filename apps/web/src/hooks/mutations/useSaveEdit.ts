/**
 * **編集フォームの保存と、その途中で挟む「適用範囲/ゲストへの通知」の問いかけ**を担当する
 * (useEventMutations から分割、2026-07-31)。
 *
 * 問いかけを同じファイルに置いてあるのは、これが saveEdit の中の1ステップだから ――
 * ダイアログの決定/キャンセルは saveEdit が await している Promise の resolve に流れるだけで、
 * 外から見ると「保存の途中で止まっている」状態にすぎない。
 *
 * 流儀は他の変更系と違って**「保存ボタン方式」**(ユーザー決定): 楽観的更新はせず、
 * POST /api/event/patch が成功して初めて store/IndexedDB へ反映する。したがって
 * ロールバック経路が無く、失敗は throw して EventEditForm 側のエラー表示に委ねる。
 */
import { useCallback, useRef, useState } from "react";
import type { IDBPDatabase } from "idb";
import {
  deleteAllDayOccurrencesByIds,
  deleteOccurrencesByIds,
  getOverride,
  getSeries,
  putAllDayOccurrences,
  putOccurrence,
  putOverride,
  putSeries,
  type KichijitsuDB,
} from "../../db/database";
import { reexpandCurrentWindow } from "../../expansion/ensureExpanded";
import type { AllDayOccurrence, Occurrence } from "../../model/types";
import type { AllDayStore } from "../../store/allDayStore";
import type { OccurrenceStore } from "../../store/occurrenceStore";
import {
  applyDraftToAllDayOccurrence,
  applyDraftToOccurrence,
  buildEventEditPatchRequest,
  subjectTimeRange,
  type EventEditDraft,
} from "../../sync/eventEdit";
import { shouldAskGuestNotify, type GuestNotify } from "../../sync/guestNotify";
import { sendJson, type CheckedFetch } from "../../sync/httpJson";
import { mergeOverridePatch, resolveOverrideRef } from "../../sync/overridePatch";
import {
  applyScopeAllToSeries,
  availableRecurrenceScopes,
  DEFAULT_RECURRENCE_SCOPE,
  EditScopeCancelledError,
  isSeriesInstance,
  type RecurrenceScope,
} from "../../sync/recurrenceScope";

/** 適用範囲ダイアログの表示状態 (null なら問いかけていない = 従来どおり素通り) */
export interface EditScopeConfirmState {
  title: string;
  scopes: readonly RecurrenceScope[];
  askNotify: boolean;
}

export function useSaveEdit({
  db,
  store,
  allDayStore,
  checkedFetch,
  timeZone,
}: {
  db: IDBPDatabase<KichijitsuDB> | null;
  store: OccurrenceStore;
  allDayStore: AllDayStore;
  checkedFetch: CheckedFetch;
  timeZone: string;
}): {
  saveEdit: (original: Occurrence | AllDayOccurrence, draft: EventEditDraft) => Promise<void>;
  editScopeConfirm: EditScopeConfirmState | null;
  confirmEditScope: (scope: RecurrenceScope, notify: GuestNotify) => void;
  cancelEditScope: () => void;
} {
  /**
   * 編集フォーム保存時の適用範囲の問いかけ (2026-07-30)。saveEdit が繰り返し予定を
   * 相手にしたときだけ立ち、ダイアログの決定/キャンセルで resolve する Promise を
   * ref に預けておく ―― saveEdit は「保存ボタン方式」で await できるので、
   * EventEditForm 側に新しい配線を足さずに問いかけを挟める。
   */
  const [editScopeConfirm, setEditScopeConfirm] = useState<EditScopeConfirmState | null>(null);
  const editScopeResolveRef = useRef<
    ((choice: { scope: RecurrenceScope; notify: GuestNotify } | null) => void) | undefined
  >(undefined);

  // ---- 編集フォーム保存時の適用範囲の問いかけ (2026-07-30) ----
  // ダイアログの決定/キャンセルを、saveEdit が await している Promise の resolve に流す。
  const confirmEditScope = useCallback((scope: RecurrenceScope, notify: GuestNotify) => {
    editScopeResolveRef.current?.({ scope, notify });
  }, []);
  const cancelEditScope = useCallback(() => {
    editScopeResolveRef.current?.(null);
  }, []);

  // ---- 予定の編集フォーム (フェーズ2、2026-07-22) ----
  // 「保存ボタン方式」(ユーザー決定): ドラッグ確定 (persist) と違い楽観的更新は行わない
  // ―― POST /api/event/patch が成功して初めて store/IndexedDB へ反映する。そのため失敗時の
  // ロールバックは不要で、EventEditForm 側がエラー表示してフォームを開いたまま再試行できる
  // ようにするだけで良い(このハンドラは reject をそのまま投げ返すだけ)。
  //
  // 終日⇔時刻の変換 (isAllDay トグル): 元が Occurrence で draft.isAllDay===true、または
  // 元が AllDayOccurrence で draft.isAllDay===false のとき、occurrenceStore⇔allDayStore
  // (および IndexedDB の occurrences⇔allDayOccurrences ストア)の間で置き換える
  // (id は Google の実 event id に対応する不変のキーなので、ストアを跨いでも同じ id を使う)。
  const saveEdit = useCallback(
    async (original: Occurrence | AllDayOccurrence, draft: EventEditDraft): Promise<void> => {
      if (!db) throw new Error("database not ready");

      // ---- 適用範囲 (2026-07-30) とゲストへの通知 (2026-07-31) の問いかけ ----
      // **繰り返しでなく、ゲストもいない予定では両方とも空/false** になり、ここは丸ごと
      // 素通りする (問いかけも series の読み出しも増えない = 従来と全く同じ経路)。
      const previousRange = subjectTimeRange(original, timeZone);
      const nextRange = { startMs: draft.startMs, endMs: draft.endMs };
      const series = isSeriesInstance(original)
        ? ((await getSeries(db, original.seriesId!)) ?? null)
        : null;
      const scopes = availableRecurrenceScopes({
        subject: original,
        series,
        previous: previousRange,
        next: nextRange,
      });
      // 繰り返しでない普通の予定でも、ゲストがいて自分が主催なら問いかける
      // (Google カレンダー自身が更新時にそうしている、sync/guestNotify.ts 参照)
      const askNotify = shouldAskGuestNotify(original);
      let scope: RecurrenceScope = DEFAULT_RECURRENCE_SCOPE;
      let notify: GuestNotify | undefined;
      if (scopes.length > 0 || askNotify) {
        // 選択肢が「この予定のみ」1つきりでも問いかけは出す ―― 繰り返し予定を編集して
        // いるのに、それが1回分だけに効くことを黙っているのが元々の問題だったため。
        const chosen = await new Promise<{ scope: RecurrenceScope; notify: GuestNotify } | null>(
          (resolve) => {
            editScopeResolveRef.current = resolve;
            setEditScopeConfirm({ title: draft.title || original.title, scopes, askNotify });
          },
        );
        editScopeResolveRef.current = undefined;
        setEditScopeConfirm(null);
        if (chosen === null) throw new EditScopeCancelledError();
        scope = chosen.scope;
        notify = chosen.notify;
      }

      const patchReq = buildEventEditPatchRequest(original, draft, timeZone, scope, series, notify);
      if (!patchReq) {
        throw new Error("kichijitsu: could not build edit EventPatchRequest");
      }
      // httpJson の postJson ではなく sendJson + 自前 throw にしてあるのは、
      // このメッセージ(kichijitsu: 接頭辞 + "(edit)")を変えないため
      const res = await sendJson(checkedFetch, "POST", "/api/event/patch", patchReq);
      if (!res.ok) {
        throw new Error(`kichijitsu: POST /api/event/patch (edit) failed: ${res.status}`);
      }

      // ---- 「すべての予定」に適用した場合 (2026-07-30) ----
      // 反映先は override ではなく series レコードそのもの。書き換えて再展開すれば、
      // 展開済み occurrence 全体にタイトル/場所/説明と時刻の変更が一貫して行き渡る
      // (persist の scope==='all' と同じ考え方)。ここまで来ている = Google への書き戻しは
      // 成功済みなので、ロールバック経路は要らない (編集フォームは「保存ボタン方式」)。
      if (scope === "all" && series) {
        await putSeries(
          db,
          applyScopeAllToSeries({
            series,
            previous: previousRange,
            next: nextRange,
            fields: {
              title: draft.title,
              location: draft.location,
              description: draft.description,
            },
          }),
        );
        await reexpandCurrentWindow(db, store);
        return;
      }

      const wasAllDay = !("startMs" in original);

      if (draft.isAllDay) {
        const nextAllDay = applyDraftToAllDayOccurrence(original, draft, timeZone);
        if (!wasAllDay) {
          // 時刻予定 → 終日予定: occurrenceStore/IndexedDB から取り除く
          store.remove([original.id]);
          await deleteOccurrencesByIds(db, [original.id]);
        }
        allDayStore.update(nextAllDay);
        await putAllDayOccurrences(db, [nextAllDay]);
        return;
      }

      const nextOcc = applyDraftToOccurrence(original, draft);
      if (wasAllDay) {
        // 終日予定 → 時刻予定: allDayStore/IndexedDB から取り除く
        allDayStore.remove([original.id]);
        await deleteAllDayOccurrencesByIds(db, [original.id]);
      } else {
        // シリーズ由来の1回分: override にも編集内容を書く(persist と同じ流儀。
        // これが無いと再展開のたびにタイトル/場所/説明がシリーズ側の値に巻き戻ってしまう)。
        // 既存 patch はスプレッドしてマージする(rsvp と同じ流儀、sync/overridePatch.ts)
        // ―― 丸ごと置き換えると mapGoogle が例外インスタンスから写した conferenceUrl /
        // hasConference / responseStatus / isOrganizer / isWorkingLocation が消え、Meet の
        // 参加リンクや参加ステータスが再展開後にシリーズ側の値へ化けてしまう。
        // 単発予定 (resolveOverrideRef が undefined) では何もしない。
        const overrideRef = resolveOverrideRef(original);
        if (overrideRef) {
          const existingOverride = await getOverride(db, overrideRef.id);
          await putOverride(
            db,
            mergeOverridePatch({
              ref: overrideRef,
              existing: existingOverride,
              fields: {
                title: draft.title,
                startMs: draft.startMs,
                endMs: draft.endMs,
                location: draft.location || undefined,
                description: draft.description || undefined,
              },
            }),
          );
        }
      }
      store.update(nextOcc);
      await putOccurrence(db, nextOcc);
    },
    [db, store, allDayStore, checkedFetch, timeZone],
  );

  return { saveEdit, editScopeConfirm, confirmEditScope, cancelEditScope };
}
