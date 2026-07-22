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

// 左ペイン常設化(2026-07-22)後、この関数は「左ペインを開くとき、右ペイン(GitHubPane)の
// overlay を閉じるべきか」だけを判定する用途に絞られたが、関数自体は左右どちらの
// PaneMode を渡しても同じ意味を持つ純粋な計算のままなので、テストの呼び方(otherMode 等の
// 引数名)は変えていない ―― 「もう片方(=右ペイン)」として読み替える。
describe("shouldCloseOtherPaneOnOpen", () => {
  it("右ペインが開いていて overlay 実効のときは閉じるべき(true)", () => {
    expect(shouldCloseOtherPaneOnOpen("overlay", true, false)).toBe(true);
  });

  it("右ペインが閉じていれば閉じる必要はない(false)", () => {
    expect(shouldCloseOtherPaneOnOpen("overlay", false, false)).toBe(false);
  });

  it("右ペインが開いていても docked 実効(広幅 + docked 選択)なら閉じない(false)", () => {
    expect(shouldCloseOtherPaneOnOpen("docked", true, false)).toBe(false);
  });

  it("右ペインが開いていて docked 選択でも、狭幅で overlay に強制される場合は閉じる(true)", () => {
    expect(shouldCloseOtherPaneOnOpen("docked", true, true)).toBe(true);
  });
});
