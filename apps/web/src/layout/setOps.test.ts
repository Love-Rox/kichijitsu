import { describe, expect, it } from "vite-plus/test";
import { addToSet, removeFromSet, toggleSetMember } from "./setOps";

describe("addToSet", () => {
  it("含まない要素を追加した新しい Set を返す(元の Set は変更しない)", () => {
    const base = new Set(["a"]);
    const next = addToSet(base, "b");
    expect([...next].sort()).toEqual(["a", "b"]);
    expect([...base]).toEqual(["a"]); // 元は不変
    expect(next).not.toBe(base);
  });

  it("既に含む要素なら同じ参照をそのまま返す(再レンダー抑制)", () => {
    const base = new Set(["a"]);
    const next = addToSet(base, "a");
    expect(next).toBe(base);
  });
});

describe("removeFromSet", () => {
  it("含む要素を除いた新しい Set を返す(元の Set は変更しない)", () => {
    const base = new Set(["a", "b"]);
    const next = removeFromSet(base, "a");
    expect([...next]).toEqual(["b"]);
    expect([...base].sort()).toEqual(["a", "b"]); // 元は不変
    expect(next).not.toBe(base);
  });

  it("元々含まない要素なら同じ参照をそのまま返す(再レンダー抑制)", () => {
    const base = new Set(["a"]);
    const next = removeFromSet(base, "z");
    expect(next).toBe(base);
  });
});

// calendarPaneGroups.ts から移設 (2026-07-25、Set 操作の一本化)
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

  it("トグルは必ず新しい Set を返す(add/remove と違い同一参照にはならない)", () => {
    const base = new Set(["a"]);
    expect(toggleSetMember(base, "a")).not.toBe(base);
    expect(toggleSetMember(base, "b")).not.toBe(base);
  });
});
