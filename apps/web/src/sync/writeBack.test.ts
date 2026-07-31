import { describe, expect, it, vi } from "vite-plus/test";
import { logSkippedWriteBack, postWriteBack } from "./writeBack";
import type { CheckedFetch } from "./httpJson";

/** console.error を黙らせて、呼ばれた内容だけ記録する */
function captureConsoleError(): { calls: unknown[][]; restore: () => void } {
  const calls: unknown[][] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    calls.push(args);
  });
  return { calls, restore: () => spy.mockRestore() };
}

describe("postWriteBack", () => {
  it("2xx なら ok:true。POST + Content-Type + JSON ボディで送る", async () => {
    const seen: { path: string; init?: RequestInit }[] = [];
    const fetcher: CheckedFetch = (path, init) => {
      seen.push({ path, init });
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const res = await postWriteBack(fetcher, "/api/event/patch", { a: 1 }, "occ-1");
    expect(res.ok).toBe(true);
    expect(res.value).toBeUndefined();
    expect(seen[0]!.path).toBe("/api/event/patch");
    expect(seen[0]!.init?.method).toBe("POST");
    expect(seen[0]!.init?.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("非 2xx は ok:false。id と status を載せてログする", async () => {
    const log = captureConsoleError();
    try {
      const fetcher: CheckedFetch = () => Promise.resolve(new Response(null, { status: 500 }));
      const res = await postWriteBack(fetcher, "/api/event/delete", {}, "occ-2");
      expect(res.ok).toBe(false);
      expect(log.calls[0]![0]).toBe("kichijitsu: POST /api/event/delete failed (occ-2): 500");
    } finally {
      log.restore();
    }
  });

  it("ネットワーク例外も ok:false に倒す(呼び出し側は同じロールバック経路を通る)", async () => {
    const log = captureConsoleError();
    try {
      const fetcher: CheckedFetch = () => Promise.reject(new Error("offline"));
      const res = await postWriteBack(fetcher, "/api/task/patch", {}, "task-1");
      expect(res.ok).toBe(false);
      expect(log.calls[0]![0]).toBe("kichijitsu: POST /api/task/patch failed");
    } finally {
      log.restore();
    }
  });

  it("readOk を渡すと 2xx のときだけ応答ボディを読んで value に載せる", async () => {
    const fetcher: CheckedFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ eventId: "ev-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const res = await postWriteBack(
      fetcher,
      "/api/event/create",
      {},
      "pending-1",
      async (r) => ((await r.json()) as { eventId: string }).eventId,
    );
    expect(res).toEqual({ ok: true, value: "ev-1" });
  });

  it("2xx でも応答ボディを読めなければ ok:false(確定 id へ差し替えられないので巻き戻す)", async () => {
    const log = captureConsoleError();
    try {
      const fetcher: CheckedFetch = () => Promise.resolve(new Response("not json"));
      const res = await postWriteBack(fetcher, "/api/event/create", {}, "pending-2", (r) =>
        r.json(),
      );
      expect(res.ok).toBe(false);
      expect(log.calls[0]![0]).toBe("kichijitsu: POST /api/event/create failed");
    } finally {
      log.restore();
    }
  });
});

describe("logSkippedWriteBack", () => {
  it("既定は 'skipping write-back'", () => {
    const log = captureConsoleError();
    try {
      logSkippedWriteBack("EventPatchRequest", "occ-3");
      expect(log.calls[0]).toEqual([
        "kichijitsu: could not build EventPatchRequest, skipping write-back",
        "occ-3",
      ]);
    } finally {
      log.restore();
    }
  });

  it("削除経路だけは 'skipping delete'(既存の文言をそのまま保つ)", () => {
    const log = captureConsoleError();
    try {
      logSkippedWriteBack("EventDeleteRequest", "occ-4", "delete");
      expect(log.calls[0]).toEqual([
        "kichijitsu: could not build EventDeleteRequest, skipping delete",
        "occ-4",
      ]);
    } finally {
      log.restore();
    }
  });
});
