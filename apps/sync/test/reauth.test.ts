import { describe, expect, it } from "vite-plus/test";
import { shouldRejectStaleRefreshTokenReuse, shouldSkipAlarmRetry } from "../src/core/reauth";

describe("shouldSkipAlarmRetry", () => {
  it("skips when a permanent failure timestamp is recorded", () => {
    expect(shouldSkipAlarmRetry(1_700_000_000_000)).toBe(true);
  });

  it("does not skip when nothing is recorded (normal operation)", () => {
    expect(shouldSkipAlarmRetry(null)).toBe(false);
  });
});

describe("shouldRejectStaleRefreshTokenReuse", () => {
  it("rejects reusing the stored token when reauth is required and Google returned no new refresh_token", () => {
    expect(shouldRejectStaleRefreshTokenReuse(false, 1_700_000_000_000)).toBe(true);
  });

  it(
    "does not reject when reauth is not required (reauthRequiredAt === null), even without a " +
      "new refresh_token — 既存の正常な挙動 (スコープ追加時の再同意など) を壊さない境界",
    () => {
      expect(shouldRejectStaleRefreshTokenReuse(false, null)).toBe(false);
    },
  );

  it("does not reject when Google did return a new refresh_token, regardless of reauthRequiredAt", () => {
    expect(shouldRejectStaleRefreshTokenReuse(true, 1_700_000_000_000)).toBe(false);
    expect(shouldRejectStaleRefreshTokenReuse(true, null)).toBe(false);
  });
});
