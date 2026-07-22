import { describe, expect, it } from "vite-plus/test";
import { effectivePaneMode, shouldCloseOtherPaneOnOpen } from "./paneMode";

describe("effectivePaneMode", () => {
  it("狭幅では常に overlay を返す(docked が選ばれていても上書きする)", () => {
    expect(effectivePaneMode("docked", true)).toBe("overlay");
  });

  it("狭幅では overlay 指定もそのまま overlay を返す", () => {
    expect(effectivePaneMode("overlay", true)).toBe("overlay");
  });

  it("広幅では docked をそのまま返す(狭幅からの復帰で永続化された docked が復元される)", () => {
    expect(effectivePaneMode("docked", false)).toBe("docked");
  });

  it("広幅では overlay をそのまま返す", () => {
    expect(effectivePaneMode("overlay", false)).toBe("overlay");
  });
});

describe("shouldCloseOtherPaneOnOpen", () => {
  it("もう片方が開いていて overlay 実効のときは閉じるべき(true)", () => {
    expect(shouldCloseOtherPaneOnOpen("overlay", true, false)).toBe(true);
  });

  it("もう片方が閉じていれば閉じる必要はない(false)", () => {
    expect(shouldCloseOtherPaneOnOpen("overlay", false, false)).toBe(false);
  });

  it("もう片方が開いていても docked 実効(広幅 + docked 選択)なら閉じない(false)", () => {
    expect(shouldCloseOtherPaneOnOpen("docked", true, false)).toBe(false);
  });

  it("もう片方が開いていて docked 選択でも、狭幅で overlay に強制される場合は閉じる(true)", () => {
    expect(shouldCloseOtherPaneOnOpen("docked", true, true)).toBe(true);
  });
});
