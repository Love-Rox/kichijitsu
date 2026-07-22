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

  it("forceFull を省略するとデフォルト false 扱いでキー自体を含めない(eventType バックフィル 2026-07-22)", () => {
    expect(buildSyncRequest("acc-1", "cal-1", "device-abc")).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      deviceId: "device-abc",
    });
  });

  it("forceFull=true なら body に forceFull: true を含める", () => {
    expect(buildSyncRequest("acc-1", "cal-1", "device-abc", true)).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      deviceId: "device-abc",
      forceFull: true,
    });
  });

  it("forceFull=true かつ deviceId=null でも forceFull は含める", () => {
    expect(buildSyncRequest("acc-1", "cal-1", null, true)).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      forceFull: true,
    });
  });
});
