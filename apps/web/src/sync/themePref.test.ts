import { describe, expect, it } from "vite-plus/test";
import { normalizeThemePref, resolveThemeAttr, resolveThemeColorMedia } from "./themePref";

describe("normalizeThemePref", () => {
  it("3択の値はそのまま通る", () => {
    expect(normalizeThemePref("auto")).toBe("auto");
    expect(normalizeThemePref("light")).toBe("light");
    expect(normalizeThemePref("dark")).toBe("dark");
  });

  it("未設定 (null / undefined) は既定の auto", () => {
    // localStorage.getItem がキー未設定で返す null と、そもそも読めなかった場合
    expect(normalizeThemePref(null)).toBe("auto");
    expect(normalizeThemePref(undefined)).toBe("auto");
  });

  it("空文字・空白だけの値も auto に倒す", () => {
    expect(normalizeThemePref("")).toBe("auto");
    expect(normalizeThemePref(" ")).toBe("auto");
    expect(normalizeThemePref("\n")).toBe("auto");
  });

  it("大文字・前後空白のゆらぎは受け付けない (完全一致のみ)", () => {
    // 保存するのはこのモジュール自身なので、ゆらぎを許す必要は無い。
    // 「読めない値なら OS 連動へ戻す」に一本化しておく方が挙動を予測しやすい。
    expect(normalizeThemePref("Dark")).toBe("auto");
    expect(normalizeThemePref("DARK")).toBe("auto");
    expect(normalizeThemePref(" dark")).toBe("auto");
    expect(normalizeThemePref("dark ")).toBe("auto");
  });

  it("古いバージョン/手書きの想定外の値も auto に倒す", () => {
    // localStorage はユーザーが直接書き換えられるうえ、選択肢を変えたときに
    // 旧バージョンの値が残る。何が来ても画面が壊れないことがこの関数の役目。
    expect(normalizeThemePref("system")).toBe("auto");
    expect(normalizeThemePref("true")).toBe("auto");
    expect(normalizeThemePref('{"pref":"dark"}')).toBe("auto");
    expect(normalizeThemePref("light dark")).toBe("auto");
  });
});

describe("resolveThemeAttr", () => {
  it("明示指定はそのまま data-theme の属性値になる", () => {
    expect(resolveThemeAttr("light")).toBe("light");
    expect(resolveThemeAttr("dark")).toBe("dark");
  });

  it("auto は null = 属性を外す (theme.css の既定 color-scheme: light dark へ戻す)", () => {
    // "auto" という属性値を書くのではなく属性ごと外すのが要点。
    expect(resolveThemeAttr("auto")).toBe(null);
  });
});

describe("resolveThemeColorMedia", () => {
  it("auto は prefers-color-scheme をそのまま使い、OS 追従をブラウザに任せる", () => {
    expect(resolveThemeColorMedia("auto")).toEqual({
      light: "(prefers-color-scheme: light)",
      dark: "(prefers-color-scheme: dark)",
    });
  });

  it("ライト固定は light 側だけを常に一致させる", () => {
    expect(resolveThemeColorMedia("light")).toEqual({ light: "all", dark: "not all" });
  });

  it("ダーク固定は dark 側だけを常に一致させる", () => {
    expect(resolveThemeColorMedia("dark")).toEqual({ light: "not all", dark: "all" });
  });

  it("どの選択でも有効な meta はちょうど1枚 (アドレスバーの色が決まらない状態を作らない)", () => {
    for (const pref of ["auto", "light", "dark"] as const) {
      const media = resolveThemeColorMedia(pref);
      // auto では OS が、明示指定では "all"/"not all" が、それぞれ排他になっている
      expect(media.light).not.toBe(media.dark);
      expect([media.light, media.dark].filter((m) => m === "not all").length).toBeLessThan(2);
    }
  });
});
