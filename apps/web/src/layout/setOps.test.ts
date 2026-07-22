import { describe, expect, it } from "vite-plus/test";
import { addToSet, removeFromSet } from "./setOps";

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
