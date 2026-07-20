import { describe, expect, it } from "vite-plus/test";
import {
  isEditableTarget,
  isViewAllowedForWidth,
  resolveShortcut,
  type KeyLike,
} from "./shortcuts";

function key(key: string, mods: Partial<Omit<KeyLike, "key">> = {}): KeyLike {
  return { key, ctrlKey: false, metaKey: false, altKey: false, ...mods };
}

describe("isEditableTarget", () => {
  it("INPUT/TEXTAREA は入力中とみなす", () => {
    expect(isEditableTarget("INPUT", false)).toBe(true);
    expect(isEditableTarget("TEXTAREA", false)).toBe(true);
  });

  it("contenteditable な要素も入力中とみなす", () => {
    expect(isEditableTarget("DIV", true)).toBe(true);
  });

  it("それ以外の要素は入力中ではない", () => {
    expect(isEditableTarget("DIV", false)).toBe(false);
    expect(isEditableTarget("BUTTON", false)).toBe(false);
    expect(isEditableTarget(null, false)).toBe(false);
    expect(isEditableTarget(undefined, false)).toBe(false);
  });
});

describe("isViewAllowedForWidth", () => {
  it("month はどちらの幅でも許容される", () => {
    expect(isViewAllowedForWidth("month", true)).toBe(true);
    expect(isViewAllowedForWidth("month", false)).toBe(true);
  });

  it("広幅では week のみ許容(day3/day1 は不可)", () => {
    expect(isViewAllowedForWidth("week", false)).toBe(true);
    expect(isViewAllowedForWidth("day3", false)).toBe(false);
    expect(isViewAllowedForWidth("day1", false)).toBe(false);
  });

  it("狭幅では day3/day1 のみ許容(week は不可)", () => {
    expect(isViewAllowedForWidth("day3", true)).toBe(true);
    expect(isViewAllowedForWidth("day1", true)).toBe(true);
    expect(isViewAllowedForWidth("week", true)).toBe(false);
  });
});

describe("resolveShortcut", () => {
  it("矢印キーは prev/next に解決する(幅に関係なく常に有効)", () => {
    expect(resolveShortcut(key("ArrowLeft"), false)).toEqual({ kind: "prev" });
    expect(resolveShortcut(key("ArrowRight"), false)).toEqual({ kind: "next" });
    expect(resolveShortcut(key("ArrowLeft"), true)).toEqual({ kind: "prev" });
  });

  it("t/T は today に解決する", () => {
    expect(resolveShortcut(key("t"), false)).toEqual({ kind: "today" });
    expect(resolveShortcut(key("T"), false)).toEqual({ kind: "today" });
  });

  it("w は広幅では week、狭幅では無視される", () => {
    expect(resolveShortcut(key("w"), false)).toEqual({ kind: "switchView", view: "week" });
    expect(resolveShortcut(key("w"), true)).toBeNull();
  });

  it("m は幅に関係なく month に解決する", () => {
    expect(resolveShortcut(key("m"), false)).toEqual({ kind: "switchView", view: "month" });
    expect(resolveShortcut(key("m"), true)).toEqual({ kind: "switchView", view: "month" });
  });

  it("d/3 は狭幅では day3、広幅では無視される", () => {
    expect(resolveShortcut(key("d"), true)).toEqual({ kind: "switchView", view: "day3" });
    expect(resolveShortcut(key("3"), true)).toEqual({ kind: "switchView", view: "day3" });
    expect(resolveShortcut(key("d"), false)).toBeNull();
    expect(resolveShortcut(key("3"), false)).toBeNull();
  });

  it("1 は狭幅では day1、広幅では無視される", () => {
    expect(resolveShortcut(key("1"), true)).toEqual({ kind: "switchView", view: "day1" });
    expect(resolveShortcut(key("1"), false)).toBeNull();
  });

  it("n/N は newEvent、? は toggleHelp、Escape は escape に解決する", () => {
    expect(resolveShortcut(key("n"), false)).toEqual({ kind: "newEvent" });
    expect(resolveShortcut(key("N"), false)).toEqual({ kind: "newEvent" });
    expect(resolveShortcut(key("?"), false)).toEqual({ kind: "toggleHelp" });
    expect(resolveShortcut(key("Escape"), false)).toEqual({ kind: "escape" });
  });

  it("Ctrl/Cmd/Alt 併用時はブラウザ標準ショートカットとの衝突を避けるため常に無視する", () => {
    expect(resolveShortcut(key("ArrowLeft", { ctrlKey: true }), false)).toBeNull();
    expect(resolveShortcut(key("t", { metaKey: true }), false)).toBeNull();
    expect(resolveShortcut(key("w", { altKey: true }), false)).toBeNull();
  });

  it("未対応のキーは null", () => {
    expect(resolveShortcut(key("x"), false)).toBeNull();
    expect(resolveShortcut(key("Enter"), false)).toBeNull();
  });
});
