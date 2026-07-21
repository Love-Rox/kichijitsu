import { describe, expect, it } from "vite-plus/test";
import { buildSyncRequest } from "./syncRequest";

describe("buildSyncRequest", () => {
  it("deviceId があれば body に含める", () => {
    expect(buildSyncRequest("acc-1", "cal-1", "device-abc")).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      deviceId: "device-abc",
    });
  });

  it("deviceId が null なら省略する(レガシー共有トークン動作へのフォールバック)", () => {
    expect(buildSyncRequest("acc-1", "cal-1", null)).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
    });
  });
});
