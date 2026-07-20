import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { GoogleTaskDTO } from "@kichijitsu/shared";
import type { TaskItem } from "../model/types";
import { buildTaskPatchRequest, mapGoogleTasks, parseDueDate, rawGoogleTaskId } from "./mapTasks";

function baseTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: "t:acc-1:list-1:task-1",
    accountId: "acc-1",
    taskListId: "list-1",
    title: "Test Task",
    dueDate: "2026-07-20",
    status: "needsAction",
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseDueDate", () => {
  it("RFC3339 (UTC 深夜0時) から日付部分を取り出す", () => {
    expect(parseDueDate("2026-07-20T00:00:00.000Z")).toBe("2026-07-20");
  });

  it("UTC 基準で日付を読む(ローカルタイムゾーンには変換しない)", () => {
    // 日本時間なら 7/20 09:00 だが、UTC のカレンダー日付である 7/19 をそのまま返す
    expect(parseDueDate("2026-07-19T00:00:00.000Z")).toBe("2026-07-19");
  });

  it("due が無ければ null", () => {
    expect(parseDueDate(undefined)).toBeNull();
  });

  it("パースできない値は null (console.warn はするが throw しない)", () => {
    expect(parseDueDate("not-a-date")).toBeNull();
  });
});

describe("mapGoogleTasks", () => {
  it("GoogleTaskDTO[] を TaskItem[] へ変換する(id 組み立て・due の日付抽出込み)", () => {
    const dtos: GoogleTaskDTO[] = [
      { id: "task-1", title: "買い物", status: "needsAction", due: "2026-07-20T00:00:00.000Z" },
      { id: "task-2", title: "完了済み", status: "completed", notes: "memo" },
    ];
    const result = mapGoogleTasks(dtos, { accountId: "acc-1", taskListId: "list-1" });
    expect(result).toEqual([
      {
        id: "t:acc-1:list-1:task-1",
        accountId: "acc-1",
        taskListId: "list-1",
        title: "買い物",
        dueDate: "2026-07-20",
        status: "needsAction",
      },
      {
        id: "t:acc-1:list-1:task-2",
        accountId: "acc-1",
        taskListId: "list-1",
        title: "完了済み",
        dueDate: null,
        status: "completed",
        notes: "memo",
      },
    ]);
  });

  it("空配列を渡せば空配列を返す", () => {
    expect(mapGoogleTasks([], { accountId: "acc-1", taskListId: "list-1" })).toEqual([]);
  });
});

describe("rawGoogleTaskId", () => {
  it("t:<accountId>:<taskListId>:<taskId> から taskId を取り出す", () => {
    expect(rawGoogleTaskId("t:acc-1:list-1:task-1", "acc-1", "list-1")).toBe("task-1");
  });

  it("taskId 自体にコロンが含まれていても安全に復元する", () => {
    expect(rawGoogleTaskId("t:acc-1:list-1:task:with:colons", "acc-1", "list-1")).toBe(
      "task:with:colons",
    );
  });

  it("accountId/taskListId が一致しなければ throw する", () => {
    expect(() => rawGoogleTaskId("t:acc-1:list-1:task-1", "acc-2", "list-1")).toThrow();
    expect(() => rawGoogleTaskId("t:acc-1:list-1:task-1", "acc-1", "list-2")).toThrow();
  });

  it("t: プレフィックスでなければ throw する", () => {
    expect(() => rawGoogleTaskId("local-task-1", "acc-1", "list-1")).toThrow();
  });
});

describe("buildTaskPatchRequest", () => {
  it("完了トグル (needsAction → completed) のリクエストを組み立てる", () => {
    const task = baseTask();
    expect(buildTaskPatchRequest(task, "completed")).toEqual({
      accountId: "acc-1",
      taskListId: "list-1",
      taskId: "task-1",
      status: "completed",
    });
  });

  it("完了トグル (completed → needsAction) のリクエストを組み立てる", () => {
    const task = baseTask({ status: "completed" });
    expect(buildTaskPatchRequest(task, "needsAction")).toEqual({
      accountId: "acc-1",
      taskListId: "list-1",
      taskId: "task-1",
      status: "needsAction",
    });
  });

  it("id のパースに失敗したら null (console.error はするが throw しない)", () => {
    const task = baseTask({ id: "not-a-matching-id" });
    expect(buildTaskPatchRequest(task, "completed")).toBeNull();
  });
});
