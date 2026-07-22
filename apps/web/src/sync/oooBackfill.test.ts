import { describe, expect, it } from "vite-plus/test";
import { decideOooBackfillTargets } from "./oooBackfill";

describe("decideOooBackfillTargets", () => {
  it("未実施 (alreadyDone: false) なら選択中の全ターゲットをそのまま返す", () => {
    const targets = [
      { accountId: "acc-1", calendarId: "cal-1" },
      { accountId: "acc-1", calendarId: "cal-2" },
      { accountId: "acc-2", calendarId: "cal-1" },
    ];

    expect(decideOooBackfillTargets(false, targets)).toBe(targets);
  });

  it("実施済み (alreadyDone: true) なら空配列を返す(再実行しない)", () => {
    const targets = [{ accountId: "acc-1", calendarId: "cal-1" }];

    expect(decideOooBackfillTargets(true, targets)).toEqual([]);
  });

  it("選択中カレンダーが無ければ未実施でも空配列", () => {
    expect(decideOooBackfillTargets(false, [])).toEqual([]);
  });

  it("accountId/calendarId 以外の付加情報 (defaultColor 等) を保ったまま透過する", () => {
    const targets = [
      { accountId: "acc-1", calendarId: "cal-1", defaultColor: "#f00", primary: true },
    ];

    expect(decideOooBackfillTargets(false, targets)).toEqual(targets);
  });
});
