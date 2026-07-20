import { describe, expect, it, vi } from 'vitest'
import { buildTasksListUrl, fetchTaskLists, fetchTasksPage, patchTaskStatus, toGoogleTaskDTO, toTaskListDTO } from '../src/google/tasks'
import { listTaskLists, patchTaskStatusWithRetry, syncTasks, type TasksCoreDeps } from '../src/core/tasks'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeTask(id: string, overrides: Partial<{ status: 'needsAction' | 'completed'; due: string }> = {}) {
  return { id, title: `Task ${id}`, status: overrides.status ?? ('needsAction' as const), due: overrides.due }
}

describe('toTaskListDTO / toGoogleTaskDTO', () => {
  it('picks id/title for task lists', () => {
    expect(toTaskListDTO({ id: 'list-1', title: 'Groceries' })).toEqual({ id: 'list-1', title: 'Groceries' })
  })

  it('picks due/status/notes/parent for tasks', () => {
    const raw = {
      id: 't1',
      title: 'Buy milk',
      status: 'needsAction' as const,
      due: '2026-07-20T00:00:00.000Z',
      notes: 'skim',
      updated: '2026-07-19T00:00:00.000Z',
      parent: 'parent-task',
    }
    expect(toGoogleTaskDTO(raw)).toEqual(raw)
  })
})

describe('fetchTaskLists', () => {
  it('GETs users/@me/lists with a bearer auth header', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(200, { items: [] }))

    await fetchTaskLists(fetchImpl, 'access-token')

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://tasks.googleapis.com/tasks/v1/users/@me/lists')
    expect((init as RequestInit).headers).toEqual({ Authorization: 'Bearer access-token' })
  })
})

describe('buildTasksListUrl / fetchTasksPage', () => {
  it('sets showCompleted/showHidden/maxResults and omits pageToken on the first page', () => {
    const url = new URL(buildTasksListUrl('list-1'))
    expect(url.pathname).toBe('/tasks/v1/lists/list-1/tasks')
    expect(url.searchParams.get('showCompleted')).toBe('true')
    expect(url.searchParams.get('showHidden')).toBe('true')
    expect(url.searchParams.get('maxResults')).toBe('100')
    expect(url.searchParams.get('pageToken')).toBeNull()
  })

  it('includes pageToken on continuation pages and URL-encodes taskListId', () => {
    const url = new URL(buildTasksListUrl('a/b@example.com', 'page-2'))
    expect(url.pathname).toBe('/tasks/v1/lists/a%2Fb%40example.com/tasks')
    expect(url.searchParams.get('pageToken')).toBe('page-2')
  })

  it('fetchTasksPage sends a bearer auth header', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(200, { items: [] }))

    await fetchTasksPage(fetchImpl, 'access-token', 'list-1')

    const init = fetchImpl.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-token')
  })
})

describe('patchTaskStatus', () => {
  it('PATCHes lists/{taskListId}/tasks/{taskId} with only status in the body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 200 }))

    await patchTaskStatus(fetchImpl, 'access-token', { taskListId: 'list-1', taskId: 'task-1', status: 'completed' })

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://tasks.googleapis.com/tasks/v1/lists/list-1/tasks/task-1')
    const requestInit = init as RequestInit
    expect(requestInit.method).toBe('PATCH')
    expect((requestInit.headers as Record<string, string>).Authorization).toBe('Bearer access-token')
    expect((requestInit.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(requestInit.body as string)).toEqual({ status: 'completed' })
  })

  it('URL-encodes taskListId and taskId', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 200 }))

    await patchTaskStatus(fetchImpl, 'access-token', {
      taskListId: 'a/b@example.com',
      taskId: 'task id with spaces',
      status: 'needsAction',
    })

    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toBe('https://tasks.googleapis.com/tasks/v1/lists/a%2Fb%40example.com/tasks/task%20id%20with%20spaces')
  })
})

interface DepsOverrides {
  accessToken?: string
}

function makeDeps(fetchImpl: typeof fetch, overrides: DepsOverrides = {}) {
  const forceRefreshAccessToken = vi.fn(async () => 'refreshed-access-token')
  const deps: TasksCoreDeps = {
    fetch: fetchImpl,
    getAccessToken: vi.fn(async () => overrides.accessToken ?? 'valid-access-token'),
    forceRefreshAccessToken,
  }
  return { deps, forceRefreshAccessToken }
}

describe('listTaskLists', () => {
  it('resolves with the mapped task lists on success', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { items: [{ id: 'list-1', title: 'Groceries' }] }))
    const { deps } = makeDeps(fetchImpl)

    await expect(listTaskLists(deps)).resolves.toEqual([{ id: 'list-1', title: 'Groceries' }])
  })

  it('returns an empty array when items is missing', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(200, {}))
    const { deps } = makeDeps(fetchImpl)

    await expect(listTaskLists(deps)).resolves.toEqual([])
  })

  it('throws GoogleApiError (without retry) on a 403 (tasks scope missing)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl)

    await expect(listTaskLists(deps)).rejects.toThrow(/403/)
    expect(forceRefreshAccessToken).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refreshes the access token once on 401 and retries the same request', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [] }))
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl, { accessToken: 'stale-access-token' })

    await expect(listTaskLists(deps)).resolves.toEqual([])
    expect(forceRefreshAccessToken).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('gives up after a second 401 (only retries once)', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl)

    await expect(listTaskLists(deps)).rejects.toThrow(/401/)
    expect(forceRefreshAccessToken).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('syncTasks', () => {
  it('combines paginated results across nextPageToken', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { items: [makeTask('t1')], nextPageToken: 'page-2' }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [makeTask('t2')] }))
    const { deps } = makeDeps(fetchImpl)

    const result = await syncTasks(deps, 'list-1')

    expect(result.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const secondUrl = new URL(fetchImpl.mock.calls[1][0] as string)
    expect(secondUrl.searchParams.get('pageToken')).toBe('page-2')
  })

  it('returns an empty array when there are no tasks', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(200, { items: [] }))
    const { deps } = makeDeps(fetchImpl)

    await expect(syncTasks(deps, 'list-1')).resolves.toEqual([])
  })

  it('refreshes the access token once on 401 and retries the same page (not resetting across pages)', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [makeTask('t1')], nextPageToken: 'page-2' }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [makeTask('t2')] }))
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl, { accessToken: 'stale-access-token' })

    const result = await syncTasks(deps, 'list-1')

    expect(result.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(forceRefreshAccessToken).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('propagates non-401 errors instead of swallowing them', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
    const { deps } = makeDeps(fetchImpl)

    await expect(syncTasks(deps, 'list-1')).rejects.toThrow(/429/)
  })
})

describe('patchTaskStatusWithRetry', () => {
  it('resolves without error on a successful patch', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 200 }))
    const { deps } = makeDeps(fetchImpl)

    await expect(
      patchTaskStatusWithRetry(deps, { taskListId: 'list-1', taskId: 'task-1', status: 'completed' }),
    ).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('throws GoogleApiError (without retry) on a 404 (task gone)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('not found', { status: 404 }))
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl)

    await expect(
      patchTaskStatusWithRetry(deps, { taskListId: 'list-1', taskId: 'task-1', status: 'completed' }),
    ).rejects.toThrow(/404/)
    expect(forceRefreshAccessToken).not.toHaveBeenCalled()
  })

  it('refreshes the access token once on 401 and retries the same request', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl, { accessToken: 'stale-access-token' })

    await expect(
      patchTaskStatusWithRetry(deps, { taskListId: 'list-1', taskId: 'task-1', status: 'needsAction' }),
    ).resolves.toBeUndefined()

    expect(forceRefreshAccessToken).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('gives up after a second 401 (only retries once)', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl)

    await expect(
      patchTaskStatusWithRetry(deps, { taskListId: 'list-1', taskId: 'task-1', status: 'completed' }),
    ).rejects.toThrow(/401/)
    expect(forceRefreshAccessToken).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
