import { describe, expect, it } from "vite-plus/test";
import { buildToolbarErrorNotes } from "./toolbarErrorNotes";

describe("buildToolbarErrorNotes", () => {
  it("returns no notes when everything is fine", () => {
    expect(
      buildToolbarErrorNotes({ syncFailed: false, saveFailed: false, reauthRequiredEmails: [] }),
    ).toEqual([]);
  });

  it("includes 同期失敗 when sync failed", () => {
    expect(
      buildToolbarErrorNotes({ syncFailed: true, saveFailed: false, reauthRequiredEmails: [] }),
    ).toEqual(["同期失敗"]);
  });

  it("includes 保存失敗 when a save failed", () => {
    expect(
      buildToolbarErrorNotes({ syncFailed: false, saveFailed: true, reauthRequiredEmails: [] }),
    ).toEqual(["保存失敗（元に戻しました）"]);
  });

  it("includes one note per reauth-required account, with its email", () => {
    expect(
      buildToolbarErrorNotes({
        syncFailed: false,
        saveFailed: false,
        reauthRequiredEmails: ["a@example.com", "b@example.com"],
      }),
    ).toEqual([
      "Google の再認証が必要です (a@example.com)",
      "Google の再認証が必要です (b@example.com)",
    ]);
  });

  it("combines all three kinds of notes, in a fixed order", () => {
    expect(
      buildToolbarErrorNotes({
        syncFailed: true,
        saveFailed: true,
        reauthRequiredEmails: ["a@example.com"],
      }),
    ).toEqual([
      "同期失敗",
      "保存失敗（元に戻しました）",
      "Google の再認証が必要です (a@example.com)",
    ]);
  });
});
