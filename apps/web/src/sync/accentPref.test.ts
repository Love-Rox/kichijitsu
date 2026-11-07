import { describe, expect, it } from "vite-plus/test";
import { ACCENT_KEYS } from "../layout/accentPalette";
import { normalizeAccentPref, resolveAccentAttr } from "./accentPref";

describe("normalizeAccentPref", () => {
  it("知っている色はそのまま返す", () => {
    for (const key of ACCENT_KEYS) expect(normalizeAccentPref(key)).toBe(key);
  });

  it("未設定・壊れた値・別名は、既定の朱に倒す", () => {
    expect(normalizeAccentPref(null)).toBe("kichijitsu");
    expect(normalizeAccentPref(undefined)).toBe("kichijitsu");
    expect(normalizeAccentPref("")).toBe("kichijitsu");
    expect(normalizeAccentPref("magenta")).toBe("kichijitsu");
    expect(normalizeAccentPref("constructor")).toBe("kichijitsu");
  });
});

describe("resolveAccentAttr", () => {
  it("既定の朱は属性を外す(null)、それ以外は色の名前", () => {
    expect(resolveAccentAttr("kichijitsu")).toBeNull();
    expect(resolveAccentAttr("indigo")).toBe("indigo");
  });
});
