/**
 * **Google タスクの完了トグル**だけを担当する (useEventMutations から分割、2026-07-31)。
 * 予定ではなくタスクが相手なので触るストアも API も別 (taskStore / POST /api/task/patch) だが、
 * 「楽観更新 → 書き戻し → 失敗ならロールバックして saveError」の流儀は移動確定と同じ。
 */
import { useCallback } from "react";
import type { IDBPDatabase } from "idb";
import { putTask, type KichijitsuDB } from "../../db/database";
import type { TaskItem } from "../../model/types";
import type { TaskStore } from "../../store/taskStore";
import type { CheckedFetch } from "../../sync/httpJson";
import { buildTaskPatchRequest } from "../../sync/mapTasks";
import { logSkippedWriteBack, postWriteBack } from "../../sync/writeBack";
import { runDetached } from "./optimisticWrites";

export function useToggleTask({
  db,
  taskStore,
  checkedFetch,
  flashSaveError,
}: {
  db: IDBPDatabase<KichijitsuDB> | null;
  taskStore: TaskStore;
  checkedFetch: CheckedFetch;
  flashSaveError: () => void;
}): { toggleTask: (task: TaskItem) => void } {
  // タスクの完了トグル(docs/google-tasks.md)。枡チェックボックスのタップから呼ばれる。
  // ドラッグ確定 (persist) と同じ流儀: 楽観的に taskStore/IndexedDB を即座に更新し、
  // POST /api/task/patch で Google へ書き戻す。失敗時は変更前の状態にロールバックし、
  // 既存の saveError 通知を再利用する。正本は次の「同期」で還流する想定
  // (Tasks API には push 通知が無いため、SSE 経由の即時還流は無い)。
  const toggleTask = useCallback(
    (task: TaskItem) => {
      if (!db) return;
      const nextStatus: TaskItem["status"] =
        task.status === "completed" ? "needsAction" : "completed";
      const previous = task;
      const updated: TaskItem = { ...task, status: nextStatus };
      // 楽観的更新: 応答を待たずに即座に見た目(枡の押印)へ反映する
      taskStore.update(updated);
      runDetached("kichijitsu: failed to persist task update", async () => {
        if (!db) return;
        await putTask(db, updated);

        const patchReq = buildTaskPatchRequest(updated, nextStatus);
        let ok = false;
        if (patchReq) {
          // レスポンス (TaskPatchResponse) は ok フラグのみで、正本は次回「同期」で還流する想定
          // (buildEventPatchRequest 経由の persist と同じ流儀。ボディは読み捨てる)
          ({ ok } = await postWriteBack(checkedFetch, "/api/task/patch", patchReq, updated.id));
        } else {
          logSkippedWriteBack("TaskPatchRequest", updated.id);
        }

        if (ok) return;

        // ロールバック: taskStore・IndexedDB を変更前の状態に戻す
        taskStore.update(previous);
        await putTask(db, previous);
        flashSaveError();
      });
    },
    [db, taskStore, checkedFetch, flashSaveError],
  );

  return { toggleTask };
}
