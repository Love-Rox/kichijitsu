/**
 * **予定の新規作成と、その薄い包みである複製 (Option+ドラッグ)** を担当する
 * (useEventMutations から分割、2026-07-31)。
 *
 * 複製を同じファイルに置いてあるのは、**複製が独立した経路ではない**から ―― 複製元と
 * ドロップ先を sync/eventCreate.ts の純関数で draft に落として createEvent に渡すだけで、
 * 楽観表示もロールバックも作成の仕組みをそのまま使う。
 */
import { useCallback } from "react";
import type { IDBPDatabase } from "idb";
import type { EventCreateResponse } from "@kichijitsu/shared";
import {
  deleteAllDayOccurrencesByIds,
  deleteOccurrencesByIds,
  putAllDayOccurrences,
  putOccurrence,
  type KichijitsuDB,
} from "../../db/database";
import type { Occurrence } from "../../model/types";
import type { AllDayStore } from "../../store/allDayStore";
import type { OccurrenceStore } from "../../store/occurrenceStore";
import {
  buildDuplicateDraft,
  buildEventCreateRequest,
  buildPendingAllDayOccurrence,
  buildPendingOccurrence,
  duplicateWriteTarget,
  finalizeCreatedAllDayOccurrence,
  finalizeCreatedOccurrence,
  type EventCreateDraft,
  type WriteTargetCandidate,
} from "../../sync/eventCreate";
import type { CheckedFetch } from "../../sync/httpJson";
import { postWriteBack } from "../../sync/writeBack";
import { runDetached } from "./optimisticWrites";

export function useCreateEvent({
  db,
  store,
  allDayStore,
  checkedFetch,
  timeZone,
  flashSaveError,
}: {
  db: IDBPDatabase<KichijitsuDB> | null;
  store: OccurrenceStore;
  allDayStore: AllDayStore;
  checkedFetch: CheckedFetch;
  timeZone: string;
  flashSaveError: () => void;
}): {
  createEvent: (draft: EventCreateDraft, target: WriteTargetCandidate) => void;
  duplicateEvent: (source: Occurrence, startMs: number, endMs: number) => void;
} {
  // 新規予定の楽観的作成(フェーズ5、2026-07-29 全項目入力に拡張)。DayColumn の
  // 速い経路(ドラッグ→タイトル→Enter)と詳細フォーム(EventEditForm)の両方から、同じ
  // draft の形で呼ばれる。仮 id (local-pending-<uuid>) の occurrence を即座に
  // store/IndexedDB へ入れて表示し、POST /api/event/create で Google へ書き込む。
  // 成功したら仮 occurrence を確定 id (`g:<accountId>:<calendarId>:<eventId>`) の
  // occurrence に差し替える — 以後 SSE/同期で同じ予定が届いても id が一致するため
  // 冪等に上書きされるだけで済み、重複表示は起きない(eventCreate.ts のコメント参照)。
  // 失敗時は仮 occurrence を削除してロールバックし、saveError を表示する。
  //
  // 終日 (draft.isAllDay) は入れ先のストアが occurrenceStore ではなく allDayStore
  // (IndexedDB も occurrences ではなく allDayOccurrences) になる。楽観表示・確定差し替え・
  // ロールバックの3箇所で同じ分岐が要るので、lane という小さな入れ物に**分岐を1箇所へ
  // 閉じ込め**、下の run() は時刻/終日を意識しない形にしてある(saveEdit の終日⇔時刻の
  // 入れ替えと同じ「ストアの選択だけが違う」という捉え方)。
  const createEvent = useCallback(
    (draft: EventCreateDraft, target: WriteTargetCandidate) => {
      if (!db) return;
      const database = db;
      const lane = draft.isAllDay
        ? (() => {
            const pending = buildPendingAllDayOccurrence({ draft, target, timeZone });
            return {
              pendingId: pending.id,
              show: () => allDayStore.update(pending),
              save: () => putAllDayOccurrences(database, [pending]),
              finalize: async (eventId: string) => {
                const finalized = finalizeCreatedAllDayOccurrence(pending, target, eventId);
                await deleteAllDayOccurrencesByIds(database, [pending.id]);
                await putAllDayOccurrences(database, [finalized]);
                await allDayStore.batch(() => {
                  allDayStore.remove([pending.id]);
                  allDayStore.update(finalized);
                });
              },
              rollback: async () => {
                await deleteAllDayOccurrencesByIds(database, [pending.id]);
                allDayStore.remove([pending.id]);
              },
            };
          })()
        : (() => {
            const pending = buildPendingOccurrence({ draft, target });
            return {
              pendingId: pending.id,
              show: () => store.update(pending),
              save: () => putOccurrence(database, pending),
              finalize: async (eventId: string) => {
                const finalized = finalizeCreatedOccurrence(pending, target, eventId);
                await deleteOccurrencesByIds(database, [pending.id]);
                await putOccurrence(database, finalized);
                // remove→update の間の空フレームを1回の通知にまとめる(点滅防止、他の箇所と同じ流儀)
                await store.batch(() => {
                  store.remove([pending.id]);
                  store.update(finalized);
                });
              },
              rollback: async () => {
                await deleteOccurrencesByIds(database, [pending.id]);
                store.remove([pending.id]);
              },
            };
          })();

      // 楽観的表示: 応答を待たずに即座に見た目へ反映する
      lane.show();
      runDetached("kichijitsu: failed to persist new occurrence", async () => {
        await lane.save();

        // 応答ボディ (eventId) の読み取りまで postWriteBack の try の中で行う ――
        // JSON が読めなければ確定 id へ差し替えようがないので、通信失敗と同じくロールバックする
        const { ok, value: eventId } = await postWriteBack(
          checkedFetch,
          "/api/event/create",
          buildEventCreateRequest({ draft, target, timeZone }),
          lane.pendingId,
          async (res) => ((await res.json()) as EventCreateResponse).eventId,
        );

        if (ok && eventId) {
          await lane.finalize(eventId);
          return;
        }

        // ロールバック: 仮 occurrence を削除
        await lane.rollback();
        flashSaveError();
      });
    },
    [db, store, allDayStore, checkedFetch, timeZone, flashSaveError],
  );

  // Option(Alt)+ドラッグでの複製(2026-07-29、ユーザー要望)。
  // **新しい作成経路は作らず**、複製元 + ドロップ先の時間帯を sync/eventCreate.ts の純関数で
  // draft + 書き込み先に落として、そのまま上の createEvent に流すだけ ―― 楽観表示(仮 id →
  // POST → 確定 id)もロールバックも既存の仕組みをそのまま使える。
  //
  // 移動 (persist) と違い、元の予定には一切触れない(store.update も patch もしない)ので
  // 移動確認ダイアログ (MoveConfirmDialog) は挟まない ―― あのダイアログは「うっかり掴んで
  // 予定の時刻を変えてしまった」を取り消すためのもので、元が変わらない複製では意味が無い
  // (増えた予定が不要なら、その予定を削除すればよい)。
  //
  // duplicateWriteTarget が null(ミラー・Busy・非 Google 等)なら何もしない。通常は
  // EventBlock 側が canDuplicateOccurrence で複製ドラッグ自体を始めないため到達しないが、
  // 呼び出し経路が増えたときのための保険として同じ判定をここにも置く。
  const duplicateEvent = useCallback(
    (source: Occurrence, startMs: number, endMs: number) => {
      const target = duplicateWriteTarget(source);
      if (!target) return;
      createEvent(buildDuplicateDraft(source, startMs, endMs), target);
    },
    [createEvent],
  );

  return { createEvent, duplicateEvent };
}
