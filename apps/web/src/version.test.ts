import { describe, expect, it } from "vite-plus/test";
import { formatBuildTime } from "./version";

describe("formatBuildTime", () => {
  it("ISO 文字列を YYYY-MM-DD HH:mm (ローカルタイム) へ整形する", () => {
    const iso = new Date(2026, 6, 22, 9, 5, 30).toISOString();
    expect(formatBuildTime(iso)).toBe("2026-07-22 09:05");
  });

  it("1桁の月/日/時/分を0埋めする", () => {
    const iso = new Date(2026, 0, 2, 3, 4, 0).toISOString();
    expect(formatBuildTime(iso)).toBe("2026-01-02 03:04");
  });

  it("不正な入力(パース不能)はそのまま元の文字列を返す", () => {
    expect(formatBuildTime("not-a-date")).toBe("not-a-date");
  });

  it("空文字はそのまま返す", () => {
    expect(formatBuildTime("")).toBe("");
  });
});
