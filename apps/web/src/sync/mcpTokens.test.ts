import { describe, expect, it } from "vite-plus/test";
import { mcpTokenLabel, mcpTokenLastUsedLabel } from "./mcpTokens";

describe("mcpTokenLabel", () => {
  it("label があればそのまま返す", () => {
    expect(mcpTokenLabel({ label: "for Claude" })).toBe("for Claude");
  });

  it("label が null なら「(無題)」を返す", () => {
    expect(mcpTokenLabel({ label: null })).toBe("(無題)");
  });

  it("label が空文字なら「(無題)」を返す", () => {
    expect(mcpTokenLabel({ label: "" })).toBe("(無題)");
  });
});

describe("mcpTokenLastUsedLabel", () => {
  it("lastUsedAt が null なら「未使用」を返す", () => {
    expect(mcpTokenLastUsedLabel({ lastUsedAt: null })).toBe("未使用");
  });

  it("lastUsedAt があれば toLocaleString された文字列を返す", () => {
    const ms = Date.UTC(2026, 6, 20, 12, 0, 0);
    expect(mcpTokenLastUsedLabel({ lastUsedAt: ms })).toBe(new Date(ms).toLocaleString());
  });
});
