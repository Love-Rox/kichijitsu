import { describe, expect, it } from "vite-plus/test";
import { shouldSkipAlarmRetry } from "../src/core/reauth";

describe("shouldSkipAlarmRetry", () => {
  it("skips when a permanent failure timestamp is recorded", () => {
    expect(shouldSkipAlarmRetry(1_700_000_000_000)).toBe(true);
  });

  it("does not skip when nothing is recorded (normal operation)", () => {
    expect(shouldSkipAlarmRetry(null)).toBe(false);
  });
});
