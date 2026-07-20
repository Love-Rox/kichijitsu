import type { GoogleTaskDTO, TaskListDTO } from '@kichijitsu/shared'

const TASKS_BASE = 'https://tasks.googleapis.com/tasks/v1'

/** Google Tasks API の tasklist リソースから必要部分だけを写した型。 */
interface RawTaskList {
  id: string
  title: string
}

interface RawTaskListsResponse {
  items?: RawTaskList[]
}

export function toTaskListDTO(raw: RawTaskList): TaskListDTO {
  return { id: raw.id, title: raw.title }
}

/**
 * `tasklists.list` を呼ぶ (GET /users/@me/lists)。呼び出し元 (core/tasks.ts) が status を
 * 見て 401 リトライ判定とエラー変換を行うため、ここでは response をそのまま返し throw
 * しない (fetchEventsPage / patchEventTime と同じ層分担)。
 *
 * tasklists はカレンダー一覧と違い数十件程度が通常であり、design (docs/google-tasks.md)
 * もページングに触れていないため、ここでは maxResults のデフォルト (20) をそのまま使い
 * ページングは実装しない。
 */
export async function fetchTaskLists(fetchFn: typeof fetch, accessToken: string): Promise<Response> {
  return fetchFn(`${TASKS_BASE}/users/@me/lists`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
}

export async function parseTaskListsResponse(response: Response): Promise<RawTaskListsResponse> {
  return (await response.json()) as RawTaskListsResponse
}

/** Google Tasks API の task リソースから必要部分だけを写した型。 */
interface RawGoogleTask {
  id: string
  title: string
  status: 'needsAction' | 'completed'
  /** RFC3339 だが日付精度のみ有効 (時刻は Google API が捨てる)。 */
  due?: string
  notes?: string
  updated?: string
  /** 親タスク (サブタスク) の id */
  parent?: string
}

interface RawTasksListResponse {
  items?: RawGoogleTask[]
  nextPageToken?: string
}

export function toGoogleTaskDTO(raw: RawGoogleTask): GoogleTaskDTO {
  return {
    id: raw.id,
    title: raw.title,
    status: raw.status,
    due: raw.due,
    notes: raw.notes,
    updated: raw.updated,
    parent: raw.parent,
  }
}

/**
 * `tasks.list` を 1 ページ分呼び出す (GET /lists/{taskListId}/tasks)。
 *
 * showCompleted=true・showHidden=true で完了/非表示タスクも含めて取得する (design:
 * 完了チェックボックスの表示や、完了済みタスクの同期に必要)。Tasks API には syncToken が
 * 無く増分同期は `updatedMin` ポーリングの領分 (design 参照、今回は初回全件取得のみ実装)
 * なので、ここでは updatedMin を渡さず常に全件を返す。maxResults=100 で
 * nextPageToken が無くなるまでページングする (呼び出し元 core/tasks.ts)。
 */
export function buildTasksListUrl(taskListId: string, pageToken?: string): string {
  const url = new URL(`${TASKS_BASE}/lists/${encodeURIComponent(taskListId)}/tasks`)
  url.searchParams.set('showCompleted', 'true')
  url.searchParams.set('showHidden', 'true')
  url.searchParams.set('maxResults', '100')
  if (pageToken) {
    url.searchParams.set('pageToken', pageToken)
  }
  return url.toString()
}

export async function fetchTasksPage(
  fetchFn: typeof fetch,
  accessToken: string,
  taskListId: string,
  pageToken?: string,
): Promise<Response> {
  return fetchFn(buildTasksListUrl(taskListId, pageToken), {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
}

export async function parseTasksListResponse(response: Response): Promise<RawTasksListResponse> {
  return (await response.json()) as RawTasksListResponse
}

export interface PatchTaskStatusParams {
  taskListId: string
  taskId: string
  status: 'needsAction' | 'completed'
}

/**
 * `tasks.patch` で status のみを書き換える (完了/未完了の枡チェックボックス書き戻し)。
 * Google 側は status を 'completed' にすると completed (完了日時) を未指定でも自動的に
 * 現在時刻で補完する挙動のため、ここでは completed フィールドを明示的に送らない。
 * wrangler dev での実地確認 (docs/google-tasks.md 検証項目) でこの挙動が崩れていたら
 * completed: new Date().toISOString() を追加すること。
 * 呼び出し元 (core/tasks.ts) が status を見て 401 リトライ判定とエラー変換を行うため、
 * ここでは response をそのまま返し throw しない (patchEventTime と同じ層分担)。
 */
export async function patchTaskStatus(
  fetchFn: typeof fetch,
  accessToken: string,
  params: PatchTaskStatusParams,
): Promise<Response> {
  const url = `${TASKS_BASE}/lists/${encodeURIComponent(params.taskListId)}/tasks/${encodeURIComponent(params.taskId)}`
  return fetchFn(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: params.status }),
  })
}
