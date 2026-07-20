import { describe, expect, it, vi } from "vite-plus/test";
import { TaskStore } from "./taskStore";
import type { TaskItem } from "../model/types";

function task(
  id: string,
  dueDate: string | null,
  status: TaskItem["status"] = "needsAction",
): TaskItem {
  return { id, accountId: "acc-1", taskListId: "list-1", title: id, dueDate, status };
}

describe("TaskStore", () => {
  it("batch 外の remove/load は即座に通知する(AllDayStore と同じ挙動)", () => {
    const store = new TaskStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.load([task("a", "2026-07-20")]);
    expect(listener).toHaveBeenCalledTimes(1);

    store.remove(["a"]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("getRange は [fromDate, toDate] (両端 inclusive) の due 付きタスクだけを日付順で返す", () => {
    const store = new TaskStore();
    store.load([
      task("mid", "2026-07-20"),
      task("early", "2026-07-18"),
      task("late", "2026-07-22"),
      task("out-of-range", "2026-08-01"),
      task("no-due", null),
    ]);

    expect(store.getRange("2026-07-18", "2026-07-22").map((t) => t.id)).toEqual([
      "early",
      "mid",
      "late",
    ]);
  });

  it("due 無しタスクは getRange の対象にならない(v1 は日付レーンに表示しない)", () => {
    const store = new TaskStore();
    store.load([task("no-due", null)]);
    expect(store.getRange("2026-01-01", "2026-12-31")).toEqual([]);
  });

  it("batch 中の update は1回の通知にまとまる", async () => {
    const store = new TaskStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.load([task("a", "2026-07-20")]);
    listener.mockClear();

    await store.batch(() => {
      store.update(task("a", "2026-07-20", "completed"));
      expect(listener).not.toHaveBeenCalled();
      store.update(task("b", "2026-07-21"));
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get("a")?.status).toBe("completed");
  });
});
