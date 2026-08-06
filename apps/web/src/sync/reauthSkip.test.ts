import { describe, expect, it } from "vite-plus/test";
import { shouldSkipAutoSyncForReauth } from "./reauthSkip";

describe("shouldSkipAutoSyncForReauth", () => {
  it("auto かつ reauthRequired のときだけ true", () => {
    expect(shouldSkipAutoSyncForReauth("auto", true)).toBe(true);
  });

  it("auto でも reauthRequired でなければ false (通常の自動同期は止めない)", () => {
    expect(shouldSkipAutoSyncForReauth("auto", false)).toBe(false);
  });

  it("manual なら reauthRequired でも false (明示的な操作は常に試す)", () => {
    expect(shouldSkipAutoSyncForReauth("manual", true)).toBe(false);
  });

  it("manual かつ reauthRequired でなければ false", () => {
    expect(shouldSkipAutoSyncForReauth("manual", false)).toBe(false);
  });
});
