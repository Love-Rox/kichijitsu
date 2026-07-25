import { describe, expect, it } from "vite-plus/test";
import {
  deleteJson,
  getJson,
  HttpError,
  jsonInit,
  patchJson,
  postJson,
  postJsonVoid,
  putJson,
  sendJson,
  throwIfNotOk,
  type CheckedFetch,
} from "./httpJson";

/** 呼び出し内容を記録する CheckedFetch のフェイク(実 fetch は使わない) */
function fakeFetch(respond: (path: string, init?: RequestInit) => Response): {
  fetch: CheckedFetch;
  calls: { path: string; init?: RequestInit }[];
} {
  const calls: { path: string; init?: RequestInit }[] = [];
  return {
    calls,
    fetch: (path, init) => {
      calls.push({ path, init });
      return Promise.resolve(respond(path, init));
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("jsonInit", () => {
  it("Content-Type ヘッダーと JSON 化したボディを載せた RequestInit を返す", () => {
    const init = jsonInit("POST", { a: 1 });
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(init.body).toBe('{"a":1}');
  });

  it("メソッドはそのまま通す(PUT/PATCH/DELETE もボディを載せられる)", () => {
    expect(jsonInit("PUT", 1).method).toBe("PUT");
    expect(jsonInit("PATCH", 1).method).toBe("PATCH");
    expect(jsonInit("DELETE", 1).method).toBe("DELETE");
  });
});

describe("HttpError / throwIfNotOk", () => {
  it("2xx はそのまま res を返す", () => {
    const res = jsonResponse({});
    expect(throwIfNotOk(res, "GET", "/api/x")).toBe(res);
  });

  it("非 2xx は既存と同じ `${method} ${path} failed: ${status}` の message で投げる", () => {
    try {
      throwIfNotOk(jsonResponse({}, 500), "POST", "/api/sync");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as Error).message).toBe("POST /api/sync failed: 500");
    }
  });

  it("status を持ち運ぶ(呼び出し側が catch 後に 401/409 を判別できる)", () => {
    try {
      throwIfNotOk(jsonResponse({}, 409), "GET", "/api/github/items");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(409);
      expect((err as HttpError).method).toBe("GET");
      expect((err as HttpError).path).toBe("/api/github/items");
    }
  });
});

describe("sendJson", () => {
  it("throw せず Response をそのまま返す(status 分岐が必要な呼び出し箇所用)", async () => {
    const f = fakeFetch(() => jsonResponse({}, 422));
    const res = await sendJson(f.fetch, "POST", "/api/event/rsvp", { id: "e1" });
    expect(res.status).toBe(422);
    expect(f.calls[0].init?.method).toBe("POST");
    expect(f.calls[0].init?.body).toBe('{"id":"e1"}');
  });
});

describe("getJson", () => {
  it("成功したらパース済みの JSON を返す(GET なので init は渡さない)", async () => {
    const f = fakeFetch(() => jsonResponse({ accounts: ["a"] }));
    const data = await getJson<{ accounts: string[] }>(f.fetch, "/api/me");
    expect(data).toEqual({ accounts: ["a"] });
    expect(f.calls).toEqual([{ path: "/api/me", init: undefined }]);
  });

  it("非 2xx は HttpError(status 付き)を投げ、ボディは読まない", async () => {
    const f = fakeFetch(() => new Response("not json", { status: 401 }));
    await expect(getJson(f.fetch, "/api/me")).rejects.toThrow("GET /api/me failed: 401");
  });

  it("fetch 自体の例外(オフライン)はそのまま伝播する", async () => {
    const boom = new TypeError("Failed to fetch");
    const f: CheckedFetch = () => Promise.reject(boom);
    await expect(getJson(f, "/api/me")).rejects.toBe(boom);
  });
});

describe("postJson / putJson", () => {
  it("postJson: JSON ボディを送り応答 JSON を返す", async () => {
    const f = fakeFetch(() => jsonResponse({ eventId: "ev1" }));
    const data = await postJson<{ title: string }, { eventId: string }>(
      f.fetch,
      "/api/event/create",
      { title: "会議" },
    );
    expect(data).toEqual({ eventId: "ev1" });
    expect(f.calls[0].init?.method).toBe("POST");
    expect(f.calls[0].init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(f.calls[0].init?.body).toBe('{"title":"会議"}');
  });

  it("postJson: 非 2xx は HttpError", async () => {
    const f = fakeFetch(() => jsonResponse({}, 502));
    await expect(postJson(f.fetch, "/api/sync", { a: 1 })).rejects.toMatchObject({
      status: 502,
      message: "POST /api/sync failed: 502",
    });
  });

  it("putJson: PUT で送り応答 JSON を返す", async () => {
    const f = fakeFetch(() => jsonResponse({ ok: true }));
    const data = await putJson<{ ids: string[] }, { ok: boolean }>(
      f.fetch,
      "/api/visible-calendars",
      { ids: ["c1"] },
    );
    expect(data).toEqual({ ok: true });
    expect(f.calls[0].init?.method).toBe("PUT");
  });
});

describe("postJsonVoid / patchJson / deleteJson", () => {
  it("postJsonVoid: 応答ボディを読まない(空ボディでも成功する)", async () => {
    const f = fakeFetch(() => new Response(null, { status: 204 }));
    await expect(postJsonVoid(f.fetch, "/api/work-logs", { repo: "o/r" })).resolves.toBeUndefined();
    expect(f.calls[0].init?.method).toBe("POST");
  });

  it("patchJson: PATCH で送り、応答ボディは読まない", async () => {
    const f = fakeFetch(() => new Response(null, { status: 204 }));
    await patchJson(f.fetch, "/api/work-logs/w1", { minutes: 30 });
    expect(f.calls[0].init?.method).toBe("PATCH");
    expect(f.calls[0].init?.body).toBe('{"minutes":30}');
  });

  it("patchJson: 非 2xx は HttpError(409 等をそのまま伝える)", async () => {
    const f = fakeFetch(() => new Response(null, { status: 409 }));
    await expect(patchJson(f.fetch, "/api/work-logs/w1", {})).rejects.toMatchObject({
      status: 409,
      message: "PATCH /api/work-logs/w1 failed: 409",
    });
  });

  it("deleteJson: body 省略時は Content-Type を付けない(ボディ無し DELETE の既存形を保つ)", async () => {
    const f = fakeFetch(() => new Response(null, { status: 204 }));
    await deleteJson(f.fetch, "/api/github");
    expect(f.calls[0].init).toEqual({ method: "DELETE" });
  });

  it("deleteJson: body ありなら JSON ボディを載せる", async () => {
    const f = fakeFetch(() => new Response(null, { status: 204 }));
    await deleteJson(f.fetch, "/api/account", { accountId: "a1" });
    expect(f.calls[0].init?.method).toBe("DELETE");
    expect(f.calls[0].init?.body).toBe('{"accountId":"a1"}');
  });

  it("deleteJson: 非 2xx は HttpError", async () => {
    const f = fakeFetch(() => new Response(null, { status: 500 }));
    await expect(deleteJson(f.fetch, "/api/block-rules", { id: "r1" })).rejects.toThrow(
      "DELETE /api/block-rules failed: 500",
    );
  });
});
