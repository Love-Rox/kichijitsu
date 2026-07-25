/**
 * JSON API を叩くときの定型(Content-Type ヘッダー・非 2xx の throw・レスポンスの
 * JSON パース)を1箇所に集める薄い層。DOM/React に依存しないためテストで固められる
 * (layout/gridMetrics.ts や sync/planned.ts と同じ流儀)。
 *
 * なぜ切り出したか: App.tsx に `headers: { "Content-Type": "application/json" }` が20箇所、
 * それと対になる `if (!res.ok) throw new Error(...)` + `(await res.json()) as XResponse` が
 * 30箇所前後コピペされていた。ヘッダーの綴り違いや「非 2xx なのに json() を読む」といった
 * 事故が起きやすい形で、しかも増えるたびに同じ4行を書き写す必要があった。
 *
 * fetch 自体はここでは呼ばない ―― App.tsx の checkedFetch(オフライン判定を挟む fetch
 * ラッパー、hooks/useOffline.ts 参照)を第1引数として受け取るだけにしてある。おかげで
 * この層は window にも React にも触れず、テストではモック関数を渡すだけで済む
 * (CheckedFetch 型はもともと sync/githubProvider.ts にあったものをここへ寄せた)。
 *
 * **status で分岐する呼び出し箇所を壊さないこと**が設計上の最重要点:
 * GitHub 系(401 = 再連携導線、409 = 未連携相当、502 = 一時的失敗)や RSVP(422 =
 * not_an_attendee)など、非 2xx を「エラー」ではなく意味のある応答として扱う箇所が多数ある。
 * そのため
 *  - throw する高レベル関数(getJson/postJson/…)は必ず status を持ち運べる HttpError を投げる
 *  - status 分岐が必要な箇所は throw させず、低レベルの sendJson / jsonInit で Response を
 *    そのまま受け取り、従来どおり自分で分岐する
 * の2段構えにしてあり、段階的な置き換えができる。
 */

/** App.tsx の checkedFetch(オフライン判定を挟む fetch ラッパー)の型 */
export type CheckedFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** JSON ボディを載せられる HTTP メソッド(GET は body を持てないので含めない) */
export type JsonBodyMethod = "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * 非 2xx を表す Error。message は置き換え前の App.tsx と同じ
 * `${method} ${path} failed: ${status}` 形式にしてある(console 出力の見た目を変えないため)。
 *
 * status を公開フィールドに持たせているのは、呼び出し側が catch 後にも 401/409 等を
 * 判別できるようにするため ―― `instanceof HttpError && err.status === 401` で分岐できる。
 */
export class HttpError extends Error {
  readonly method: string;
  readonly path: string;
  readonly status: number;

  constructor(method: string, path: string, status: number) {
    super(`${method} ${path} failed: ${status}`);
    this.name = "HttpError";
    this.method = method;
    this.path = path;
    this.status = status;
  }
}

/**
 * JSON ボディ付きリクエストの RequestInit。Content-Type ヘッダーと JSON.stringify を
 * 1箇所にまとめるだけの純関数 ―― status 分岐が必要で高レベル関数を使えない箇所でも、
 * これだけは使える(ヘッダーのコピペを消せる)。
 */
export function jsonInit<T>(method: JsonBodyMethod, body: T): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * 低レベル: JSON ボディ付きリクエストを送り、Response をそのまま返す(非 2xx でも throw しない)。
 * 401/409/422 等を呼び出し側で分岐する必要がある箇所はこれを使う。
 */
export function sendJson<TReq>(
  f: CheckedFetch,
  method: JsonBodyMethod,
  path: string,
  body: TReq,
): Promise<Response> {
  return f(path, jsonInit(method, body));
}

/** 非 2xx なら HttpError を投げる。2xx ならそのまま res を返す(チェーンして使えるように) */
export function throwIfNotOk(res: Response, method: string, path: string): Response {
  if (!res.ok) throw new HttpError(method, path, res.status);
  return res;
}

/** 「成功なら JSON を返す / 失敗なら HttpError」の共通実装。json() は 2xx のときだけ読む */
async function requestJson<TRes>(
  f: CheckedFetch,
  method: string,
  path: string,
  init: RequestInit | undefined,
): Promise<TRes> {
  const res = await f(path, init);
  throwIfNotOk(res, method, path);
  return (await res.json()) as TRes;
}

/** GET して JSON を返す。非 2xx は HttpError */
export function getJson<TRes>(f: CheckedFetch, path: string): Promise<TRes> {
  return requestJson<TRes>(f, "GET", path, undefined);
}

/** POST(JSON ボディ)して応答 JSON を返す。非 2xx は HttpError */
export function postJson<TReq, TRes>(f: CheckedFetch, path: string, body: TReq): Promise<TRes> {
  return requestJson<TRes>(f, "POST", path, jsonInit("POST", body));
}

/** PUT(JSON ボディ)して応答 JSON を返す。非 2xx は HttpError */
export function putJson<TReq, TRes>(f: CheckedFetch, path: string, body: TReq): Promise<TRes> {
  return requestJson<TRes>(f, "PUT", path, jsonInit("PUT", body));
}

/**
 * POST(JSON ボディ)するが応答ボディは読まない版。204 や「{id} しか返らないので使わない」
 * 書き込み系のため ―― json() を呼ばないので、空ボディで応答されても失敗しない。
 */
export async function postJsonVoid<TReq>(
  f: CheckedFetch,
  path: string,
  body: TReq,
): Promise<void> {
  throwIfNotOk(await sendJson(f, "POST", path, body), "POST", path);
}

/** PATCH(JSON ボディ)。応答ボディは読まない。非 2xx は HttpError */
export async function patchJson<TReq>(f: CheckedFetch, path: string, body: TReq): Promise<void> {
  throwIfNotOk(await sendJson(f, "PATCH", path, body), "PATCH", path);
}

/**
 * DELETE。応答ボディは読まない(204 想定)。非 2xx は HttpError。
 * body 省略時は Content-Type ヘッダーも付けない ―― ボディ無しの DELETE
 * (`{ method: "DELETE" }` だけ)という既存の呼び出し形をそのまま保つため。
 */
export async function deleteJson<TReq>(
  f: CheckedFetch,
  path: string,
  body?: TReq,
): Promise<void> {
  const init: RequestInit = body === undefined ? { method: "DELETE" } : jsonInit("DELETE", body);
  throwIfNotOk(await f(path, init), "DELETE", path);
}
