import { describe, expect, it } from "vite-plus/test";
import { effectivePaneMode } from "./paneMode";

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
