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
import {
  deleteOccurrencesByIds,
  putOccurrence,
  putOverride,
  type KichijitsuDB,
} from "../../db/database";
import type { Occurrence } from "../../model/types";
import type { OccurrenceStore } from "../../store/occurrenceStore";
import { buildEventDeleteRequest } from "../../sync/eventPatch";
import { shouldAskGuestNotify, type GuestNotify } from "../../sync/guestNotify";
import type { CheckedFetch } from "../../sync/httpJson";
import type { RecurrenceScope } from "../../sync/recurrenceScope";
import { logSkippedWriteBack, postWriteBack } from "../../sync/writeBack";
import { runDetached, snapshotOverride } from "./optimisticWrites";

export function useDeleteOccurrence({
  db,
  store,
  checkedFetch,
  flashSaveError,
}: {
  db: IDBPDatabase<KichijitsuDB> | null;
  store: OccurrenceStore;
  checkedFetch: CheckedFetch;
  flashSaveError: () => void;
}): {
  deleteOccurrence: (occurrence: Occurrence) => void;
  deleteConfirm: { occurrence: Occurrence } | null;
  confirmDelete: (scope: RecurrenceScope, notify: GuestNotify) => void;
  cancelDelete: () => void;
} {
  /**
   * ゲストのいる予定の削除確認 (2026-07-31)。deleteOccurrence が
   * shouldAskGuestNotify(occurrence) のときだけ立てる ―― それ以外は null のままで、
   * 削除はポップオーバー内のインライン2段階確認だけで完了する (従来と同じ)。
   * moveConfirm と違い**まだ何も書き換えていない**ので、キャンセルは state を落とすだけ。
   */
  const [deleteConfirm, setDeleteConfirm] = useState<{ occurrence: Occurrence } | null>(null);

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
    (occurrence: Occurrence, notify?: GuestNotify) => {
      if (!db) return;
      runDetached("kichijitsu: failed to delete occurrence", async () => {
        if (!db) return;

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
          ({ ok } = await postWriteBack(
            checkedFetch,
            "/api/event/delete",
            deleteReq,
            occurrence.id,
          ));
        } else {
          logSkippedWriteBack("EventDeleteRequest", occurrence.id, "delete");
        }

        if (ok) return;

        // ロールバック: occurrence と override を復元
        store.update(occurrence);
        await putOccurrence(db, occurrence);
        await override.restore();
        flashSaveError();
      });
    },
    [db, store, checkedFetch, flashSaveError],
  );

  // ---- ゲストのいる予定の削除確認 (2026-07-31) ----
  // 削除は取り消せないので、ゲストがいて自分が主催のときだけ、ポップオーバー内の
  // インライン2段階確認を確認ダイアログへ格上げして「削除するか」と「ゲストへの通知」を
  // 一度に訊く (components/MoveConfirmDialog.tsx の purpose='delete')。
  // **判定は移動・編集と同じ shouldAskGuestNotify** ―― 削除用の条件は作らない。
  const deleteOccurrence = useCallback(
    (occurrence: Occurrence) => {
      if (shouldAskGuestNotify(occurrence)) {
        setDeleteConfirm({ occurrence });
        return;
      }
      runDelete(occurrence);
    },
    [runDelete],
  );

  // 適用範囲 (scope) は受け取るが使わない: 削除はダイアログに適用範囲を出さない
  // (scopes を渡していない) ので必ず既定のまま届く。繰り返し予定の削除は従来どおり
  // その1回分だけに効く ―― 2026-07-31 で変えていない。
  const confirmDelete = useCallback(
    (_scope: RecurrenceScope, notify: GuestNotify) => {
      if (!deleteConfirm) return;
      runDelete(deleteConfirm.occurrence, notify);
      setDeleteConfirm(null);
    },
    [deleteConfirm, runDelete],
  );

  const cancelDelete = useCallback(() => setDeleteConfirm(null), []);

  return { deleteOccurrence, deleteConfirm, confirmDelete, cancelDelete };
}
