import { describe, expect, it } from "vite-plus/test";
import { calendarPaneGroupKey } from "./calendarPaneGroups";

describe("calendarPaneGroupKey", () => {
  it("`${accountId}:${kind}` の形でキーを組み立てる", () => {
    expect(calendarPaneGroupKey("acc-1", "mine")).toBe("acc-1:mine");
    expect(calendarPaneGroupKey("acc-1", "others")).toBe("acc-1:others");
    expect(calendarPaneGroupKey("acc-2", "tasks")).toBe("acc-2:tasks");
  });

  it("同じ kind でもアカウントが違えば別キーになる(アカウント間で折りたたみ状態が混ざらない)", () => {
    expect(calendarPaneGroupKey("acc-1", "mine")).not.toBe(calendarPaneGroupKey("acc-2", "mine"));
  });
});
