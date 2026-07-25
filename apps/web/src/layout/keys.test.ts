import { describe, expect, it } from "vite-plus/test";
import { calendarKey, calendarKeyOf, taskListKey } from "./keys";

describe("calendarKey", () => {
  it("`${accountId}:${calendarId}` の形でキーを組み立てる", () => {
    expect(calendarKey("acct-1", "primary")).toBe("acct-1:primary");
  });

  it("Google の実 id(メールアドレス形式のカレンダー id)でも壊れない", () => {
    expect(calendarKey("a1", "ja.japanese#holiday@group.v.calendar.google.com")).toBe(
      "a1:ja.japanese#holiday@group.v.calendar.google.com",
    );
  });
});

describe("calendarKeyOf", () => {
  it("Occurrence 相当のオブジェクトから calendarKey と同じキーを作る", () => {
    expect(calendarKeyOf({ accountId: "acct-1", calendarId: "primary" })).toBe(
      calendarKey("acct-1", "primary"),
    );
  });

  it("accountId/calendarId が無いローカル予定は、選択キー集合のどれにも一致しないキーになる", () => {
    const visible = new Set([calendarKey("acct-1", "primary")]);
    expect(visible.has(calendarKeyOf({}))).toBe(false);
    expect(visible.has(calendarKeyOf({ accountId: "acct-1" }))).toBe(false);
    expect(visible.has(calendarKeyOf({ calendarId: "primary" }))).toBe(false);
  });
});

describe("taskListKey", () => {
  it("`${accountId}:${taskListId}` の形でキーを組み立てる", () => {
    expect(taskListKey("acct-1", "list-9")).toBe("acct-1:list-9");
  });

  it("calendarKey と同じ文字列形(混ぜないための呼び分けは呼び出し側の責務)", () => {
    expect(taskListKey("a", "b")).toBe(calendarKey("a", "b"));
  });
});
