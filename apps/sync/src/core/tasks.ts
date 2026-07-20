import type { GoogleTaskDTO, TaskListDTO } from '@kichijitsu/shared'
import { GoogleApiError } from './errors'
import {
  fetchTaskLists,
  fetchTasksPage,
  parseTaskListsResponse,
  parseTasksListResponse,
  patchTaskStatus,
  toGoogleTaskDTO,
  toTaskListDTO,
  type PatchTaskStatusParams,
} from '../google/tasks'

/**
 * UserSyncDO のタスク系 RPC (listTaskLists/syncTasks/patchTask) が共通で実装すべき
 * 依存先。core/patch-event.ts の PatchEventCoreDeps と同じ考え方で、DO storage /
 * 実際の fetch を注入してロジックだけを単体テストできるようにする。
 */
export interface TasksCoreDeps {
  fetch: typeof fetch
  /** キャッシュがあれば使い、無ければ (または期限切れなら) refresh_token から取り直す。 */
  getAccessToken: () => Promise<string>
  /** キャッシュを無視して強制的にリフレッシュする (401 リトライ用)。 */
  forceRefreshAccessToken: () => Promise<string>
}

/**
 * GET /api/tasklists: アカウントのタスクリスト一覧を取得する。core/sync.ts の runSync と
 * 同様、401 のみ 1 回だけ強制リフレッシュして同じリクエストを再試行する。
 * tasks スコープが付与されていない場合、Google は 403 を返す — routes/api.ts 側が
 * この 403 を tasks_scope_missing として扱う (design: 最小実装ではスコープの有無を
 * D1 に保存せず、実際に Google を叩いた結果で判定する)。
 */
export async function listTaskLists(deps: TasksCoreDeps): Promise<TaskListDTO[]> {
  let accessToken = await deps.getAccessToken()
  let retriedAuth = false

  for (;;) {
    const response = await fetchTaskLists(deps.fetch, accessToken)

    if (response.status === 401 && !retriedAuth) {
      retriedAuth = true
      accessToken = await deps.forceRefreshAccessToken()
      continue
    }

    if (!response.ok) {
      throw new GoogleApiError(response.status, await response.text())
    }

    const body = await parseTaskListsResponse(response)
    return (body.items ?? []).map(toTaskListDTO)
  }
}

/**
 * POST /api/tasks/sync: 指定タスクリストの全タスクを取得する。Tasks API には syncToken が
 * 無いため (design 参照)、常に showCompleted=true&showHidden=true の全件取得を
 * nextPageToken が無くなるまでページングする。401 の強制リフレッシュはページをまたいで
 * 1 回だけ (core/sync.ts の runSync と同じ方針)。
 */
export async function syncTasks(deps: TasksCoreDeps, taskListId: string): Promise<GoogleTaskDTO[]> {
  const tasks: GoogleTaskDTO[] = []
  let pageToken: string | undefined
  let accessToken = await deps.getAccessToken()
  let retriedAuth = false

  for (;;) {
    const response = await fetchTasksPage(deps.fetch, accessToken, taskListId, pageToken)

    if (response.status === 401 && !retriedAuth) {
      retriedAuth = true
      accessToken = await deps.forceRefreshAccessToken()
      continue
    }

    if (!response.ok) {
      throw new GoogleApiError(response.status, await response.text())
    }

    const body = await parseTasksListResponse(response)
    tasks.push(...(body.items ?? []).map(toGoogleTaskDTO))

    if (body.nextPageToken) {
      pageToken = body.nextPageToken
      continue
    }

    return tasks
  }
}

/**
 * POST /api/task/patch: タスクの完了状態を Google へ書き戻す。core/patch-event.ts の
 * patchEventTimeWithRetry と同様、401 のみ 1 回だけ強制リフレッシュして同じリクエストを
 * 再試行する。404/403 等や 401 リトライ後もなお失敗する場合は握りつぶさず
 * GoogleApiError として伝播させる — 呼び出し元 (route) がこれを 409 patch_failed 等に
 * マップし、クライアントに楽観更新のロールバックを促す。
 *
 * 書き込みが成功しても戻り値は無い (void)。正本は次の同期 (クライアントの
 * /api/tasks/sync 再取得) で還流する設計であり、ここで Google の応答ボディを整形して
 * クライアントへ返すことはしない (patchEventTimeWithRetry と同じ方針)。
 */
export async function patchTaskStatusWithRetry(deps: TasksCoreDeps, params: PatchTaskStatusParams): Promise<void> {
  let accessToken = await deps.getAccessToken()
  let retriedAuth = false

  for (;;) {
    const response = await patchTaskStatus(deps.fetch, accessToken, params)

    if (response.status === 401 && !retriedAuth) {
      retriedAuth = true
      accessToken = await deps.forceRefreshAccessToken()
      continue
    }

    if (!response.ok) {
      throw new GoogleApiError(response.status, await response.text())
    }

    return
  }
}
