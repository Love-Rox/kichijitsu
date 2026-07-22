import { describe, expect, it } from "vite-plus/test";
import { calendarPaneGroupKey, toggleSetMember } from "./calendarPaneGroups";

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

describe("toggleSetMember", () => {
  it("集合に無いキーは追加する", () => {
    const result = toggleSetMember(new Set(), "acc-1:mine");
    expect(result.has("acc-1:mine")).toBe(true);
  });

  it("集合にあるキーは削除する", () => {
    const result = toggleSetMember(new Set(["acc-1:mine"]), "acc-1:mine");
    expect(result.has("acc-1:mine")).toBe(false);
  });

  it("引数の Set 自体は変更しない(イミュータブル)", () => {
    const original = new Set(["acc-1:mine"]);
    toggleSetMember(original, "acc-1:others");
    expect(original.has("acc-1:others")).toBe(false);
    expect(original.size).toBe(1);
  });

  it("他のキーには影響しない", () => {
    const result = toggleSetMember(new Set(["acc-1:mine", "acc-1:tasks"]), "acc-1:mine");
    expect(result.has("acc-1:mine")).toBe(false);
    expect(result.has("acc-1:tasks")).toBe(true);
  });
});
