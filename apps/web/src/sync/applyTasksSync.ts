import type { IDBPDatabase } from "idb";
import type { TasksSyncResponse } from "@kichijitsu/shared";
import type { KichijitsuDB } from "../db/database";
import { deleteTasksByIds, getAllTasks, putTasks } from "../db/database";
import type { TaskStore } from "../store/taskStore";
import { mapGoogleTasks, type MapTasksContext } from "./mapTasks";

/**
 * apps/sync から受け取った TasksSyncResponse (1つの (accountId, taskListId) ぶん) を
 * IndexedDB に適用し、store に反映する。
 *
 * Tasks API には syncToken が無く (docs/google-tasks.md)、TasksSyncResponse は常に
 * そのタスクリストの全件を返す設計 (protocol.ts の TasksSyncRequest コメント参照) なので、
 * 毎回「このタスクリストの既存タスクのうち応答に含まれなかったもの」を削除してから
 * 書き直す — applySync.ts の isFullSync 分岐と同じ考え方を常時適用する形になる。
 */
export async function applyTasksSyncResponse(
  db: IDBPDatabase<KichijitsuDB>,
  taskStore: TaskStore,
  res: TasksSyncResponse,
  ctx: MapTasksContext,
): Promise<void> {
  const mapped = mapGoogleTasks(res.tasks, ctx);
  const mappedIds = new Set(mapped.map((t) => t.id));

  const existing = await getAllTasks(db);
  const staleIds = existing
    .filter(
      (t) =>
        t.accountId === ctx.accountId && t.taskListId === ctx.taskListId && !mappedIds.has(t.id),
    )
    .map((t) => t.id);

  await taskStore.batch(async () => {
    if (staleIds.length > 0) {
      await deleteTasksByIds(db, staleIds);
      taskStore.remove(staleIds);
    }
    await putTasks(db, mapped);
    taskStore.load(mapped);
  });
}

/**
 * アカウント連携解除 (App.tsx の handleDisconnectAccount) 時、そのアカウントの
 * ローカルタスクを一括で削除する。deleteGoogleData (applySync.ts) のタスク版
 */
export async function deleteTasksForAccount(
  db: IDBPDatabase<KichijitsuDB>,
  taskStore: TaskStore,
  accountId: string,
): Promise<void> {
  const existing = await getAllTasks(db);
  const ids = existing.filter((t) => t.accountId === accountId).map((t) => t.id);
  if (ids.length === 0) return;
  await deleteTasksByIds(db, ids);
  taskStore.remove(ids);
}
