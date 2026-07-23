import { describe, expect, it, vi } from "vite-plus/test";
import { TimeEntryStore } from "./timeEntryStore";
import type { TimeEntry } from "../model/types";

function entry(id: string, linkedItemId: string, startMs: number, endMs: number | null): TimeEntry {
  return {
    id,
    linkedItemId,
    itemType: "issue",
    title: id,
    repo: "owner/repo",
    number: 1,
    url: "https://github.com/owner/repo/issues/1",
    startMs,
    endMs,
  };
}

describe("TimeEntryStore", () => {
  it("load/upsert/remove はそれぞれ即座に1回通知する(バッチ外の既存挙動)", () => {
    const store = new TimeEntryStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.load([entry("a", "item-a", 0, null)]);
    expect(listener).toHaveBeenCalledTimes(1);

    store.upsert(entry("a", "item-a", 0, 1000));
    expect(listener).toHaveBeenCalledTimes(2);

    store.remove(["a"]);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("upsert は同一 id を上書きする(start→stop が同じ経路)", () => {
    const store = new TimeEntryStore();
    store.upsert(entry("a", "item-a", 0, null));
    store.upsert(entry("a", "item-a", 0, 1000));

    expect(store.get("a")).toEqual(expect.objectContaining({ id: "a", endMs: 1000 }));
    expect(store.getAll()).toHaveLength(1);
  });

  it("getAll は全件を返す", () => {
    const store = new TimeEntryStore();
    store.load([entry("a", "item-a", 0, 1000), entry("b", "item-b", 1000, 2000)]);
    expect(
      store
        .getAll()
        .map((e) => e.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  describe("複数併走(単一走行の制約は無い)", () => {
    it("別々の linkedItemId は同時に複数走行中になれる", () => {
      const store = new TimeEntryStore();
      store.upsert(entry("a", "item-a", 0, null));
      store.upsert(entry("b", "item-b", 0, null));

      const running = store.getRunningEntries();
      expect(running.map((e) => e.id).sort()).toEqual(["a", "b"]);
      expect(store.isRunning("item-a")).toBe(true);
      expect(store.isRunning("item-b")).toBe(true);
      expect(store.isRunning("item-c")).toBe(false);
    });

    it("getRunningEntries は endMs===null のものだけを返す(確定済みは含めない)", () => {
      const store = new TimeEntryStore();
      store.load([
        entry("a", "item-a", 0, null),
        entry("b", "item-b", 0, 1000), // 確定済み
      ]);
      expect(store.getRunningEntries().map((e) => e.id)).toEqual(["a"]);
      expect(store.isRunning("item-b")).toBe(false);
    });

    it("特定 item の停止(upsert で endMs を埋める)は他 item の走行に影響しない", () => {
      const store = new TimeEntryStore();
      store.upsert(entry("a", "item-a", 0, null));
      store.upsert(entry("b", "item-b", 0, null));

      store.upsert(entry("a", "item-a", 0, 500)); // item-a だけ停止

      expect(store.isRunning("item-a")).toBe(false);
      expect(store.isRunning("item-b")).toBe(true);
      expect(store.getRunningEntries().map((e) => e.id)).toEqual(["b"]);
    });

    it("同一 linkedItemId で2件目の走行中エントリを upsert しても両方保持する(二重防止はストアの責務外)", () => {
      // ストア自身は id 単位の素朴な上書きのみを行う。「同じ item は二重に start しない」不変条件は
      // 呼び出し側(App.onStartTimer)が isRunning() を見てから upsert する形で担保する設計
      const store = new TimeEntryStore();
      store.upsert(entry("a", "item-a", 0, null));
      store.upsert(entry("a2", "item-a", 100, null));

      expect(
        store
          .getRunningEntries()
          .map((e) => e.id)
          .sort(),
      ).toEqual(["a", "a2"]);
    });
  });

  describe("replaceAll(サーバー開区間の射影)", () => {
    it("内容を丸ごと置き換え、削除された id は消える", () => {
      const store = new TimeEntryStore();
      store.load([entry("a", "item-a", 0, null), entry("b", "item-b", 0, null)]);
      store.replaceAll([entry("b", "item-b", 0, null), entry("c", "item-c", 0, null)]);
      expect(
        store
          .getRunningEntries()
          .map((e) => e.id)
          .sort(),
      ).toEqual(["b", "c"]);
      expect(store.get("a")).toBeUndefined();
    });

    it("内容が完全一致なら通知しない(ポーリング空振りで再描画しない)", () => {
      const store = new TimeEntryStore();
      const listener = vi.fn();
      store.load([entry("a", "item-a", 0, null)]);
      store.subscribe(listener);
      store.replaceAll([entry("a", "item-a", 0, null)]);
      expect(listener).not.toHaveBeenCalled();
    });

    it("startMs など1フィールドでも変われば通知する", () => {
      const store = new TimeEntryStore();
      const listener = vi.fn();
      store.load([entry("a", "item-a", 0, null)]);
      store.subscribe(listener);
      store.replaceAll([entry("a", "item-a", 500, null)]);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("件数が変われば通知する", () => {
      const store = new TimeEntryStore();
      const listener = vi.fn();
      store.load([entry("a", "item-a", 0, null)]);
      store.subscribe(listener);
      store.replaceAll([]);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(store.getRunningEntries()).toHaveLength(0);
    });
  });

  it("batch 中の複数 upsert は1回の通知にまとまる", async () => {
    const store = new TimeEntryStore();
    const listener = vi.fn();
    store.subscribe(listener);

    await store.batch(() => {
      store.upsert(entry("a", "item-a", 0, null));
      store.upsert(entry("b", "item-b", 0, null));
      expect(listener).not.toHaveBeenCalled();
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getRunningEntries()).toHaveLength(2);
  });
});
