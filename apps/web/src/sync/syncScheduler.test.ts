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

/** 保留中のマイクロタスク/タイマーを一巡させる(「まだ解決していない」の確認用) */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createSyncScheduler", () => {
  it("走行中の同一キーへの再要求は新規実行せず、trailing rerun に合流する", async () => {
    const scheduler = createSyncScheduler();
    const d1 = deferred();
    let callCount = 0;
    const run = vi.fn(() => {
      callCount += 1;
      return callCount === 1 ? d1.promise : Promise.resolve();
    });

    const p1 = scheduler.schedule("acc:cal", run);
    const p2 = scheduler.schedule("acc:cal", run); // 走行中に再要求

    expect(run).toHaveBeenCalledTimes(1); // まだ新規実行はしていない

    d1.resolve();
    await Promise.all([p1, p2]);

    // 走行中に来た再要求ぶんの trailing rerun が1回走る
    expect(run).toHaveBeenCalledTimes(2);
  });

  // schedule() が返す Promise は「そのキーが落ち着いたこと」ではなく「その要求を満たす run 1回」を
  // 表す(2026-07-31)。走行中の run は再要求より前に始まっているので、それでは要求を満たさない
  it("再要求の Promise は、要求より後に始まった run が完了するまで解決しない", async () => {
    const scheduler = createSyncScheduler();
    const d1 = deferred();
    const d2 = deferred();
    let callCount = 0;
    const run = vi.fn(() => {
      callCount += 1;
      return callCount === 1 ? d1.promise : d2.promise;
    });

    const p1 = scheduler.schedule("acc:cal", run);
    const p2 = scheduler.schedule("acc:cal", run);
    let p2Settled = false;
    void p2.then(() => {
      p2Settled = true;
    });

    d1.resolve();
    await p1;
    await flush();
    // 走行中だった1回目が終わっただけでは、再要求はまだ満たされていない
    expect(p2Settled).toBe(false);

    d2.resolve();
    await p2;
    expect(p2Settled).toBe(true);
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

  // 合流可能 (coalesce 既定 true) な要求どうしは last-wins で1回に潰す。同一キーの run は
  // 互換なので、より新しい closure(更新後のカレンダー色などを掴んでいる)を採るほうが安全側。
  // 「落としてほしくない要求」は coalesce: false で表明する(下の describe 参照)
  it("trailing rerun は最後に要求された run で実行される", async () => {
    const scheduler = createSyncScheduler();
    const d1 = deferred();
    const normalSync = vi.fn(() => d1.promise);
    const fullSync = vi.fn(() => Promise.resolve());

    const p1 = scheduler.schedule("acc:cal", normalSync);
    void scheduler.schedule("acc:cal", fullSync); // 走行中に全同期を要求

    expect(fullSync).not.toHaveBeenCalled();

    d1.resolve();
    await p1;

    // trailing rerun は「初回と同じ通常同期」ではなく、後から来た全同期のほう
    expect(normalSync).toHaveBeenCalledTimes(1);
    expect(fullSync).toHaveBeenCalledTimes(1);
  });

  it("走行中に複数の run が要求されたら trailing rerun は最後の1つだけ", async () => {
    const scheduler = createSyncScheduler();
    const d1 = deferred();
    const first = vi.fn(() => d1.promise);
    const second = vi.fn(() => Promise.resolve());
    const third = vi.fn(() => Promise.resolve());

    const p1 = scheduler.schedule("acc:cal", first);
    void scheduler.schedule("acc:cal", second);
    void scheduler.schedule("acc:cal", third);

    d1.resolve();
    await p1;

    expect(second).not.toHaveBeenCalled();
    expect(third).toHaveBeenCalledTimes(1);
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

  // 「利用者が明示的に押した再同期」「同期バックフィル」のように、実行されたこと自体に意味がある
  // 要求は coalesce: false で予約する(2026-07-31)。first-wins/last-wins の二択だとどちらかの向きで
  // 明示要求が黙って消えるため、「捨ててよいと宣言された run だけを捨てる」規則にした
  describe("coalesce: false(落とせない要求)", () => {
    it("予約済みの全同期は、後から来た通常同期に上書きされず必ず実行される", async () => {
      const scheduler = createSyncScheduler();
      const d1 = deferred();
      const normalSync = vi.fn(() => d1.promise);
      const fullSync = vi.fn(() => Promise.resolve());
      const laterNormalSync = vi.fn(() => Promise.resolve());

      const p1 = scheduler.schedule("acc:cal", normalSync);
      // 走行中に利用者が「再同期」を押し、その隙に SSE changed の通常同期が届く、という順序
      const pFull = scheduler.schedule("acc:cal", fullSync, { coalesce: false });
      const pLater = scheduler.schedule("acc:cal", laterNormalSync);

      d1.resolve();
      await Promise.all([p1, pFull, pLater]);

      expect(fullSync).toHaveBeenCalledTimes(1); // 全同期は落ちない
      expect(laterNormalSync).not.toHaveBeenCalled(); // 通常同期は全同期に相乗りして潰れる
      expect(normalSync).toHaveBeenCalledTimes(1); // 走行中だった1回だけ
    });

    it("後から来た通常同期の Promise は、相乗り先の全同期が完了するまで解決しない", async () => {
      const scheduler = createSyncScheduler();
      const d1 = deferred();
      const dFull = deferred();
      const normalSync = vi.fn(() => d1.promise);
      const fullSync = vi.fn(() => dFull.promise);
      const laterNormalSync = vi.fn(() => Promise.resolve());

      const p1 = scheduler.schedule("acc:cal", normalSync);
      const pFull = scheduler.schedule("acc:cal", fullSync, { coalesce: false });
      const pLater = scheduler.schedule("acc:cal", laterNormalSync);
      let laterSettled = false;
      void pLater.then(() => {
        laterSettled = true;
      });

      d1.resolve();
      await flush();
      expect(fullSync).toHaveBeenCalledTimes(1);
      expect(laterSettled).toBe(false); // 相乗り先がまだ走っている

      dFull.resolve();
      await Promise.all([p1, pFull, pLater]);
      expect(laterSettled).toBe(true);
    });

    it("先に予約された通常同期を吸収するので、trailing は全同期1回だけになる", async () => {
      const scheduler = createSyncScheduler();
      const d1 = deferred();
      const running = vi.fn(() => d1.promise);
      const queuedNormalSync = vi.fn(() => Promise.resolve());
      const fullSync = vi.fn(() => Promise.resolve());

      const p1 = scheduler.schedule("acc:cal", running);
      const pNormal = scheduler.schedule("acc:cal", queuedNormalSync); // 先に予約された通常同期
      const pFull = scheduler.schedule("acc:cal", fullSync, { coalesce: false });

      d1.resolve();
      await Promise.all([p1, pNormal, pFull]);

      // 吸収されるので実行は「走行中の1回 + 全同期1回」= 2回のまま(合流の効果は維持)
      expect(queuedNormalSync).not.toHaveBeenCalled();
      expect(fullSync).toHaveBeenCalledTimes(1);
      expect(running).toHaveBeenCalledTimes(1);
    });

    it("落とせない要求どうしは潰さず、どちらも実行される", async () => {
      const scheduler = createSyncScheduler();
      const d1 = deferred();
      const running = vi.fn(() => d1.promise);
      const fullA = vi.fn(() => Promise.resolve());
      const fullB = vi.fn(() => Promise.resolve());

      const p1 = scheduler.schedule("acc:cal", running);
      const pA = scheduler.schedule("acc:cal", fullA, { coalesce: false });
      const pB = scheduler.schedule("acc:cal", fullB, { coalesce: false });

      d1.resolve();
      await Promise.all([p1, pA, pB]);

      expect(fullA).toHaveBeenCalledTimes(1);
      expect(fullB).toHaveBeenCalledTimes(1);
    });

    it("Promise は自分の run 自身の成否を返す(合流で他人の結果にすり替わらない)", async () => {
      const scheduler = createSyncScheduler();
      const d1 = deferred();
      const running = vi.fn(() => d1.promise);
      const fullSync = vi.fn(() => Promise.reject(new Error("full boom")));

      const p1 = scheduler.schedule("acc:cal", running);
      const pFull = scheduler.schedule("acc:cal", fullSync, { coalesce: false });
      const rejects = expect(pFull).rejects.toThrow("full boom");

      d1.resolve();
      await p1; // 走行中だった通常同期は成功したまま
      await rejects;
    });
  });

  // 失敗はラウンド単位。以前は failed フラグがラウンドを跨いで残り、1回目が失敗すると
  // trailing rerun が成功しても呼び出し元全員に「失敗」を見せていた (2026-07-31 修正)
  describe("失敗の伝播", () => {
    it("1回目が失敗し trailing rerun が成功したら、失敗するのは1回目の呼び出し元だけ", async () => {
      const scheduler = createSyncScheduler();
      const d1 = deferred();
      let callCount = 0;
      const run = vi.fn(() => {
        callCount += 1;
        return callCount === 1 ? d1.promise : Promise.resolve();
      });

      const p1 = scheduler.schedule("acc:cal", run);
      const p2 = scheduler.schedule("acc:cal", run);
      const rejects = expect(p1).rejects.toThrow("boom");

      d1.reject(new Error("boom"));

      await rejects; // 1回目を待っていた呼び出し元は失敗を観測する
      await expect(p2).resolves.toBeUndefined(); // trailing rerun は成功したので resolve
      expect(run).toHaveBeenCalledTimes(2); // 失敗しても trailing rerun は走る
    });

    it("1回目が成功し trailing rerun が失敗したら、失敗するのは trailing の呼び出し元だけ", async () => {
      const scheduler = createSyncScheduler();
      const d1 = deferred();
      let callCount = 0;
      const run = vi.fn(() => {
        callCount += 1;
        return callCount === 1 ? d1.promise : Promise.reject(new Error("late boom"));
      });

      const p1 = scheduler.schedule("acc:cal", run);
      const p2 = scheduler.schedule("acc:cal", run);
      const rejects = expect(p2).rejects.toThrow("late boom");

      d1.resolve();
      await expect(p1).resolves.toBeUndefined();
      await rejects;
    });
  });
});
