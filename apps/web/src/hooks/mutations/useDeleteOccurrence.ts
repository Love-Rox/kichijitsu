/**
 * **予定の削除と、ゲストがいるときの削除確認ダイアログ**を担当する
 * (useEventMutations から分割、2026-07-31)。
 *
 * 実際に消す手順 (runDelete) と「消してよいか+通知を送るか」を訊く入口 (deleteOccurrence)
 * を同じファイルに置いてある ―― 確認は削除の前段でしかなく、間に他の経路は挟まらない。
 * 移動確認と違い**ダイアログを開いた時点ではまだ1件も書き換えていない**ので、
 * キャンセルは state を落とすだけで済む。
 */
import { useCallback, useState } from "react";
import type { IDBPDatabase } from "idb";
import { Temporal } from "@js-temporal/polyfill";
import {
  deleteAllDayOccurrencesByIds,
  deleteOccurrencesByIds,
  deleteOverridesByIds,
  deleteSeriesByIds,
  getAllOccurrences,
  getAllOverrides,
  getAllSeries,
  putAllDayOccurrences,
  putOccurrence,
  putOccurrences,
  putOverride,
  putSeries,
  type KichijitsuDB,
} from "../../db/database";
import type { AllDayOccurrence, Occurrence } from "../../model/types";
import type { AllDayStore } from "../../store/allDayStore";
import type { OccurrenceStore } from "../../store/occurrenceStore";
import { buildEventDeleteRequest } from "../../sync/eventPatch";
import { shouldAskGuestNotify, type GuestNotify } from "../../sync/guestNotify";
import type { CheckedFetch } from "../../sync/httpJson";
import {
  buildSeriesDeleteRequest,
  instancesInRange,
  isRecurringGoogleOccurrence,
  MAX_RANGE_DELETE,
  type DeleteScope,
} from "../../sync/recurrenceDelete";
import { logSkippedWriteBack, postWriteBack } from "../../sync/writeBack";
import { runDetached, snapshotOverride } from "./optimisticWrites";

/** 削除の確認ダイアログの状態。recurring = 削除の範囲を訊く、askNotify = ゲストへの通知を訊く。 */
export interface DeleteConfirm {
  occurrence: Occurrence | AllDayOccurrence;
  recurring: boolean;
  askNotify: boolean;
}

export function useDeleteOccurrence({
  db,
  store,
  allDayStore,
  checkedFetch,
  flashSaveError,
}: {
  db: IDBPDatabase<KichijitsuDB> | null;
  store: OccurrenceStore;
  allDayStore: AllDayStore;
  checkedFetch: CheckedFetch;
  flashSaveError: () => void;
}): {
  deleteOccurrence: (occurrence: Occurrence | AllDayOccurrence) => void;
  deleteConfirm: DeleteConfirm | null;
  confirmDelete: (scope: DeleteScope, notify: GuestNotify, until?: string) => void;
  /** 「この回から指定の日まで」で消える回数(ダイアログの見出し用)。繰り返しの回以外・展開できないときは 0 */
  countRange: (occurrence: Occurrence, until: string) => Promise<number>;
  cancelDelete: () => void;
} {
  /**
   * ゲストのいる予定の削除確認 (2026-07-31)。deleteOccurrence が
   * shouldAskGuestNotify(occurrence) のときだけ立てる ―― それ以外は null のままで、
   * 削除はポップオーバー内のインライン2段階確認だけで完了する (従来と同じ)。
   * moveConfirm と違い**まだ何も書き換えていない**ので、キャンセルは state を落とすだけ。
   */
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirm | null>(null);

  /**
   * 繰り返しの1回分(または単発の時刻予定)を、楽観的に消して Google へ書き戻す。失敗したら元に戻し、
   * false を返す(エラー表示は呼び出し側 ―― 複数回をまとめて消すときに、失敗ごとに出さないため)。
   */
  const deleteInstance = useCallback(
    async (occurrence: Occurrence, notify?: GuestNotify): Promise<boolean> => {
      if (!db) return false;
      const override = await snapshotOverride(db, occurrence);

      // 楽観的削除: 応答を待たずに即座に見た目から消す
      store.remove([occurrence.id]);
      await deleteOccurrencesByIds(db, [occurrence.id]);
      if (override.ref) {
        await putOverride(db, { ...override.ref, patch: null });
      }

      const deleteReq = buildEventDeleteRequest(occurrence, notify);
      let ok = false;
      if (deleteReq) {
        ({ ok } = await postWriteBack(checkedFetch, "/api/event/delete", deleteReq, occurrence.id));
      } else {
        logSkippedWriteBack("EventDeleteRequest", occurrence.id, "delete");
      }
      if (ok) return true;

      // ロールバック: occurrence と override を復元
      store.update(occurrence);
      await putOccurrence(db, occurrence);
      await override.restore();
      return false;
    },
    [db, store, checkedFetch],
  );

  // 予定の楽観的削除(フェーズ5)。EventBlock の詳細ポップオーバーの削除ボタン(2段階確認)
  // から呼ばれる。occurrence を即座に store/IndexedDB から取り除き、シリーズ由来の
  // 1回分なら override (patch: null = EXDATE 相当、model/series.ts 参照) を書いて
  // 再展開後も現れないようにする(v1 の簡易実装: 本来は EXDATE をシリーズ側に足すのが
  // 正だが、既存の override 機構を流用する)。POST /api/event/delete で Google へ
  // 書き戻し、失敗時は occurrence(と override)を復元してロールバックし、saveError を表示する。
  // 成功後に SSE/同期で cancelled が届いても既に消えているため冪等。
  //
  // notify (2026-07-31) は確認ダイアログで選ばれたゲストへの通知。**訊いていない経路
  // (ゲスト無し・自分が主催でない = 削除のほとんど) では省略され**、
  // buildEventDeleteRequest の中の resolveSendUpdates が安全側 (externalOnly) に倒す
  // ―― 知らせる相手がいないのだから Google 側の結果は従来と1つも変わらない。
  const runDelete = useCallback(
    (occurrence: Occurrence | AllDayOccurrence, notify?: GuestNotify) => {
      if (!db) return;
      runDetached("kichijitsu: failed to delete occurrence", async () => {
        if (!db) return;

        // 終日予定 (2026-11-06): 入れ先のストアが違うだけで手順は同じ。終日は繰り返しを
        // 持たない (seriesId が常に null) ので override には触れない
        if (!("startMs" in occurrence)) {
          const allDay = occurrence;
          allDayStore.remove([allDay.id]);
          await deleteAllDayOccurrencesByIds(db, [allDay.id]);

          const req = buildEventDeleteRequest(allDay, notify);
          let allDayOk = false;
          if (req) {
            ({ ok: allDayOk } = await postWriteBack(
              checkedFetch,
              "/api/event/delete",
              req,
              allDay.id,
            ));
          } else {
            logSkippedWriteBack("EventDeleteRequest", allDay.id, "delete");
          }
          if (allDayOk) return;

          allDayStore.update(allDay);
          await putAllDayOccurrences(db, [allDay]);
          flashSaveError();
          return;
        }

        if (!(await deleteInstance(occurrence, notify))) flashSaveError();
      });
    },
    [db, allDayStore, checkedFetch, flashSaveError, deleteInstance],
  );

  // ---- ゲストのいる予定の削除確認 (2026-07-31) ----
  // 削除は取り消せないので、ゲストがいて自分が主催のときだけ、ポップオーバー内の
  // インライン2段階確認を確認ダイアログへ格上げして「削除するか」と「ゲストへの通知」を
  // 一度に訊く (components/MoveConfirmDialog.tsx の purpose='delete')。
  // **判定は移動・編集と同じ shouldAskGuestNotify** ―― 削除用の条件は作らない。
  const deleteOccurrence = useCallback(
    (occurrence: Occurrence | AllDayOccurrence) => {
      const recurring = isRecurringGoogleOccurrence(occurrence);
      const askNotify = shouldAskGuestNotify(occurrence);
      // 繰り返しの回は、削除の範囲(この回のみ/指定の日まで/すべて)を訊くので、必ずダイアログを開く
      if (recurring || askNotify) {
        setDeleteConfirm({ occurrence, recurring, askNotify });
        return;
      }
      runDelete(occurrence);
    },
    [runDelete],
  );

  /** シリーズ全体の削除(親を消す)。手元のシリーズ・例外・展開済みの回を消し、失敗したら戻す。 */
  const runDeleteAll = useCallback(
    (occurrence: Occurrence, notify?: GuestNotify) => {
      if (!db || !occurrence.seriesId) return;
      const seriesId = occurrence.seriesId;
      runDetached("kichijitsu: failed to delete series", async () => {
        if (!db) return;
        const [allSeries, allOverrides, allOccurrences] = await Promise.all([
          getAllSeries(db),
          getAllOverrides(db),
          getAllOccurrences(db),
        ]);
        const series = allSeries.find((s) => s.id === seriesId);
        const overrides = allOverrides.filter((o) => o.seriesId === seriesId);
        const occurrences = allOccurrences.filter((o) => o.seriesId === seriesId);

        // 楽観的削除
        store.remove(occurrences.map((o) => o.id));
        await deleteOccurrencesByIds(db, occurrences.map((o) => o.id));
        await deleteOverridesByIds(db, overrides.map((o) => o.id));
        await deleteSeriesByIds(db, [seriesId]);

        const req = buildSeriesDeleteRequest(occurrence, notify);
        let ok = false;
        if (req) {
          ({ ok } = await postWriteBack(checkedFetch, "/api/event/delete", req, seriesId));
        } else {
          logSkippedWriteBack("EventDeleteRequest", seriesId, "delete");
        }
        if (ok) return;

        // ロールバック: シリーズ・例外・展開済みの回を戻す
        if (series) await putSeries(db, series);
        for (const o of overrides) await putOverride(db, o);
        await putOccurrences(db, occurrences);
        store.load(occurrences);
        flashSaveError();
      });
    },
    [db, store, checkedFetch, flashSaveError],
  );

  /** 「この回から指定の日まで」の対象の回(開始順、上限 MAX_RANGE_DELETE)。シリーズが無ければ空。 */
  const rangeTargets = useCallback(
    async (occurrence: Occurrence, until: string): Promise<Occurrence[]> => {
      if (!db || !occurrence.seriesId) return [];
      const [allSeries, allOverrides] = await Promise.all([getAllSeries(db), getAllOverrides(db)]);
      const series = allSeries.find((s) => s.id === occurrence.seriesId);
      if (!series) return [];
      return instancesInRange(
        series,
        allOverrides,
        occurrence,
        Temporal.PlainDate.from(until),
        Temporal.Now.timeZoneId(),
      ).slice(0, MAX_RANGE_DELETE);
    },
    [db],
  );

  const countRange = useCallback(
    async (occurrence: Occurrence, until: string) => (await rangeTargets(occurrence, until)).length,
    [rangeTargets],
  );

  /** 連続した回をまとめて消す。1 回ずつ消して書き戻し、失敗した回だけ元に戻す(エラー表示は 1 回)。 */
  const runDeleteRange = useCallback(
    (occurrence: Occurrence, until: string, notify?: GuestNotify) => {
      runDetached("kichijitsu: failed to delete occurrence range", async () => {
        const targets = await rangeTargets(occurrence, until);
        let failed = false;
        for (const target of targets) {
          if (!(await deleteInstance(target, notify))) failed = true;
        }
        if (failed) flashSaveError();
      });
    },
    [rangeTargets, deleteInstance, flashSaveError],
  );

  const confirmDelete = useCallback(
    (scope: DeleteScope, notify: GuestNotify, until?: string) => {
      if (!deleteConfirm) return;
      const { occurrence } = deleteConfirm;
      if (isRecurringGoogleOccurrence(occurrence)) {
        if (scope === "all") runDeleteAll(occurrence, notify);
        else if (scope === "range" && until) runDeleteRange(occurrence, until, notify);
        else runDelete(occurrence, notify);
      } else {
        runDelete(occurrence, notify);
      }
      setDeleteConfirm(null);
    },
    [deleteConfirm, runDelete, runDeleteAll, runDeleteRange],
  );

  const cancelDelete = useCallback(() => setDeleteConfirm(null), []);

  return { deleteOccurrence, deleteConfirm, confirmDelete, countRange, cancelDelete };
}
