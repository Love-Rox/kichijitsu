import { describe, expect, it } from "vite-plus/test";
import { decideSyncBackfillTargets } from "./syncBackfill";

describe("decideSyncBackfillTargets", () => {
  it("savedVersion が currentVersion 未満なら選択中の全ターゲットをそのまま返す", () => {
    const targets = [
      { accountId: "acc-1", calendarId: "cal-1" },
      { accountId: "acc-1", calendarId: "cal-2" },
      { accountId: "acc-2", calendarId: "cal-1" },
    ];

    expect(decideSyncBackfillTargets(0, 2, targets)).toBe(targets);
    expect(decideSyncBackfillTargets(1, 2, targets)).toBe(targets);
  });

  it("savedVersion === currentVersion なら空配列を返す(既に追いついている)", () => {
    const targets = [{ accountId: "acc-1", calendarId: "cal-1" }];

    expect(decideSyncBackfillTargets(2, 2, targets)).toEqual([]);
  });

  it("savedVersion > currentVersion (理論上あり得ないが念のため) でも空配列を返す", () => {
    const targets = [{ accountId: "acc-1", calendarId: "cal-1" }];

    expect(decideSyncBackfillTargets(3, 2, targets)).toEqual([]);
  });

  it("選択中カレンダーが無ければ未達でも空配列", () => {
    expect(decideSyncBackfillTargets(0, 2, [])).toEqual([]);
  });

  it("accountId/calendarId 以外の付加情報 (defaultColor 等) を保ったまま透過する", () => {
    const targets = [
      { accountId: "acc-1", calendarId: "cal-1", defaultColor: "#f00", primary: true },
    ];

    expect(decideSyncBackfillTargets(0, 2, targets)).toEqual(targets);
  });
});
