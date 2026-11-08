import { API_BASE } from "./config";
import { getToken } from "./auth";

/** HTTP のエラー応答。呼び出し側が status で出し分けられるようにする(例: 出欠の 422)。 */
export class ApiError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number,
    /** エラー応答の本文(JSON なら中身)。読めなければ null。422 の理由(split_unsupported など)を見るのに使う。 */
    public readonly body: unknown = null,
  ) {
    super(`${path} -> ${status}`);
    this.name = "ApiError";
  }
}

/** セッションを Bearer で付けて Worker の API を呼ぶ。401 は null を返す(未ログイン扱い)。 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  const token = await getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new ApiError(path, res.status, await res.json().catch(() => null));
  // 204 No Content (例: PUT /api/visible-calendars)は、本文が無いので JSON として読まない
  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}
