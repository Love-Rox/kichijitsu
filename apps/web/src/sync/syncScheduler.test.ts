import { describe, expect, it, vi } from "vite-plus/test";
import { createSyncScheduler } from "./syncScheduler";

/** 外部から resolve/reject を制御できる Promise (走行中の状態を作るためのテスト用ヘルパー) */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSyncScheduler", () => {
  it("走行中の同一キーへの再要求は新規実行せず、同じ Promise に合流する", async () => {
    const scheduler = createSyncScheduler();
    const d1 = deferred();
    let callCount = 0;
    const run = vi.fn(() => {
      callCount += 1;
      return callCount === 1 ? d1.promise : Promise.resolve();
    });

    const p1 = scheduler.schedule("acc:cal", run);
    const p2 = scheduler.schedule("acc:cal", run); // 走行中に再要求

    expect(p2).toBe(p1); // 同じ Promise に合流している
    expect(run).toHaveBeenCalledTimes(1); // まだ新規実行はしていない

    d1.resolve();
    await p1;

    // 走行中に来た再要求ぶんの trailing rerun が1回走る
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("走行中に何度再要求しても trailing rerun は1回に潰される", async () => {
    const scheduler = createSyncScheduler();
    const d1 = deferred();
    let callCount = 0;
    const run = vi.fn(() => {
      callCount += 1;
      return callCount === 1 ? d1.promise : Promise.resolve();
    });

    const p1 = scheduler.schedule("acc:cal", run);
    void scheduler.schedule("acc:cal", run);
    void scheduler.schedule("acc:cal", run);
    void scheduler.schedule("acc:cal", run); // 4回要求(初回+3回の再要求)

    d1.resolve();
    await p1;

    // 初回の実行 + trailing rerun 1回 = 合計2回。再要求の数だけ増えたりはしない
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("エラー時もロックが解放され、次の schedule は新規に実行される", async () => {
    const scheduler = createSyncScheduler();
    const run1 = vi.fn().mockRejectedValueOnce(new Error("boom"));

    await expect(scheduler.schedule("acc:cal", run1)).rejects.toThrow("boom");

    // 前回の失敗を引きずってロックが残っていないか、次の schedule で確認する
    const run2 = vi.fn().mockResolvedValue(undefined);
    await scheduler.schedule("acc:cal", run2);
    expect(run2).toHaveBeenCalledTimes(1);
  });

  it("異なるキーは互いに独立して同時に走行できる", async () => {
    const scheduler = createSyncScheduler();
    const dA = deferred();
    const dB = deferred();
    const runA = vi.fn(() => dA.promise);
    const runB = vi.fn(() => dB.promise);

    const pA = scheduler.schedule("acc:cal-a", runA);
    const pB = scheduler.schedule("acc:cal-b", runB);

    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).toHaveBeenCalledTimes(1);

    dA.resolve();
    dB.resolve();
    await Promise.all([pA, pB]);
  });
});
