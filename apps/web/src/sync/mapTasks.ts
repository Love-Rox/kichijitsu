import { Temporal } from '@js-temporal/polyfill'
import type { GoogleTaskDTO, TaskPatchRequest } from '@kichijitsu/shared'
import type { TaskItem } from '../model/types'

/**
 * Google Tasks の task DTO を kichijitsu のローカルモデルへ変換する純関数層
 * (docs/google-tasks.md、mapGoogle.ts の考え方をタスク向けに写したもの)。
 *
 * id 規則: `t:<accountId>:<taskListId>:<task.id>` (mapGoogle.ts の eventKey と同じ思想。
 * task.id 自体にコロンが含まれても、accountId/taskListId は TaskItem のフィールドとして
 * そのまま持つため、逆変換は prefix を剥がすだけで安全に行える — rawGoogleTaskId 参照)。
 */
export interface MapTasksContext {
  accountId: string
  taskListId: string
}

/** id 規則: `t:<accountId>:<taskListId>:<taskId>` */
function taskKey(ctx: MapTasksContext, taskId: string): string {
  return `t:${ctx.accountId}:${ctx.taskListId}:${taskId}`
}

/**
 * GoogleTaskDTO.due (RFC3339、日付精度のみ有効) から日付部分 (YYYY-MM-DD) を取り出す。
 * Google は常に UTC 深夜 0時 (`...T00:00:00.000Z`) で返す仕様のため、ローカルタイムゾーンへ
 * 変換すると前後の日にズレる — 必ず UTC のカレンダー日付として読む。
 * due が無い/パースできない場合は null (v1 では日付レーンに表示しないタスク扱い)。
 */
export function parseDueDate(due: string | undefined): string | null {
  if (!due) return null
  try {
    return Temporal.Instant.from(due).toZonedDateTimeISO('UTC').toPlainDate().toString()
  } catch (err) {
    console.warn(`mapGoogleTasks: failed to parse due date "${due}"`, err)
    return null
  }
}

/** GoogleTaskDTO[] → TaskItem[]。1件の変換失敗は同期全体を巻き込まないよう warn してスキップする */
export function mapGoogleTasks(tasks: GoogleTaskDTO[], ctx: MapTasksContext): TaskItem[] {
  const items: TaskItem[] = []
  for (const task of tasks) {
    try {
      items.push({
        id: taskKey(ctx, task.id),
        accountId: ctx.accountId,
        taskListId: ctx.taskListId,
        title: task.title,
        dueDate: parseDueDate(task.due),
        status: task.status,
        ...(task.notes !== undefined ? { notes: task.notes } : {}),
      })
    } catch (err) {
      console.warn(`mapGoogleTasks: failed to convert task ${task.id}, skipping`, err)
    }
  }
  return items
}

/**
 * TaskItem.id (`t:<accountId>:<taskListId>:<taskId>`) から Google の生 task id を取り出す。
 * accountId/taskListId は呼び出し側 (TaskItem のフィールド) から渡すことで、taskId 自体に
 * コロンが含まれていても安全に復元できる (mapGoogle.ts の rawGoogleEventId と同じ思想)。
 */
export function rawGoogleTaskId(id: string, accountId: string, taskListId: string): string {
  const prefix = `t:${accountId}:${taskListId}:`
  if (!id.startsWith(prefix)) {
    throw new Error(`kichijitsu: not a matching task id: "${id}" (expected prefix "${prefix}")`)
  }
  return id.slice(prefix.length)
}

/**
 * 枡チェックボックスのトグルから POST /api/task/patch の body を組み立てる。
 * id のパースに失敗した場合は null (呼び出し側で warn/error する)。
 */
export function buildTaskPatchRequest(
  task: TaskItem,
  nextStatus: TaskItem['status'],
): TaskPatchRequest | null {
  try {
    const taskId = rawGoogleTaskId(task.id, task.accountId, task.taskListId)
    return {
      accountId: task.accountId,
      taskListId: task.taskListId,
      taskId,
      status: nextStatus,
    }
  } catch (err) {
    console.error('kichijitsu: failed to build TaskPatchRequest', err)
    return null
  }
}
