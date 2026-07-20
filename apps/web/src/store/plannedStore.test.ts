import { describe, expect, it, vi } from "vite-plus/test";
import { PlannedStore } from "./plannedStore";
import type { PlannedBlock } from "../model/types";

function planned(id: string, startMs: number, endMs: number): PlannedBlock {
  return {
    id,
    startMs,
    endMs,
    linkedItemId: `ghq:owner/repo:issue:${id}`,
    itemType: "issue",
    title: id,
    repo: "owner/repo",
    number: 1,
    url: `https://github.com/owner/repo/issues/1`,
  };
}

describe("PlannedStore", () => {
  it("load/upsert/remove はそれぞれ即座に1回通知する(バッチ外の既存挙動)", () => {
    const store = new PlannedStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.load([planned("a", 0, 1000)]);
    expect(listener).toHaveBeenCalledTimes(1);

    store.upsert(planned("a", 0, 2000));
    expect(listener).toHaveBeenCalledTimes(2);

    store.remove(["a"]);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("upsert は同一 id を上書きする(新規作成/移動/リサイズが同じ経路)", () => {
    const store = new PlannedStore();
    store.upsert(planned("a", 0, 1000));
    store.upsert({ ...planned("a", 0, 1000), startMs: 500, endMs: 1500 });

    expect(store.get("a")).toEqual(expect.objectContaining({ id: "a", startMs: 500, endMs: 1500 }));
    // 上書きなので件数は1件のまま
    expect(store.getRange(0, 10_000)).toHaveLength(1);
  });

  it("getRange は [startMs, endMs) の半開区間で重なりを判定する", () => {
    const store = new PlannedStore();
    store.load([
      planned("before", 0, 1000), // 範囲より前(重ならない)
      planned("touching-start", 1000, 2000), // 範囲の開始に接するだけ(重ならない、endMs===fromMs)
      planned("overlapping", 1500, 2500), // 範囲に食い込む(重なる)
      planned("inside", 2000, 3000), // 範囲内(重なる)
      planned("touching-end", 3000, 4000), // 範囲の終了に接するだけ(重ならない、startMs===toMs)
      planned("after", 4000, 5000), // 範囲より後(重ならない)
    ]);

    const result = store.getRange(2000, 3000).map((b) => b.id);
    expect(result).toEqual(["overlapping", "inside"]);
  });

  it("getRange の結果は開始時刻順", () => {
    const store = new PlannedStore();
    store.load([planned("c", 2000, 3000), planned("a", 0, 1000), planned("b", 1000, 2000)]);

    expect(store.getRange(0, 10_000).map((b) => b.id)).toEqual(["a", "b", "c"]);
  });

  it("batch 中の remove→upsert は1回の通知にまとまり、中間状態が観測されない", async () => {
    const store = new PlannedStore();
    const listener = vi.fn();
    store.load([planned("a", 0, 1000)]);
    store.subscribe(listener);

    await store.batch(() => {
      store.remove(["a"]);
      expect(listener).not.toHaveBeenCalled();
      store.upsert(planned("b", 1000, 2000));
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getRange(0, 10_000).map((b) => b.id)).toEqual(["b"]);
  });

  it("batch 内で変化がなければ通知はゼロ回", async () => {
    const store = new PlannedStore();
    const listener = vi.fn();
    store.subscribe(listener);

    await store.batch(() => {
      store.remove(["nonexistent"]);
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("ネストした batch でも最外周が抜けたときに1回だけ通知する", async () => {
    const store = new PlannedStore();
    const listener = vi.fn();
    store.subscribe(listener);

    await store.batch(async () => {
      await store.batch(() => {
        store.load([planned("a", 0, 1000)]);
      });
      expect(listener).not.toHaveBeenCalled();
      store.load([planned("b", 1000, 2000)]);
    });

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
