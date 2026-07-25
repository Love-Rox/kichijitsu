import { describe, expect, it } from "vite-plus/test";
import {
  decideSyncBackfillTargets,
  resolveEffectiveSyncBackfillVersion,
} from "./syncBackfill";

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

// サーバー対応世代でクランプする(2026-07-25、web だけ先にデプロイされた状態で
// 「サーバーがまだ返さないフィールド」をバックフィル済みと記録してしまう事故の恒久対策)。
describe("resolveEffectiveSyncBackfillVersion", () => {
  it("サーバーが自世代より古ければサーバー世代までに抑える", () => {
    expect(resolveEffectiveSyncBackfillVersion(5, 3)).toBe(3);
  });

  it("サーバーが自世代以上なら自世代のまま", () => {
    expect(resolveEffectiveSyncBackfillVersion(5, 5)).toBe(5);
    expect(resolveEffectiveSyncBackfillVersion(5, 7)).toBe(5);
  });

  it("宣言が無い(旧サーバー/未取得)なら自世代のまま(従来の挙動)", () => {
    expect(resolveEffectiveSyncBackfillVersion(5, undefined)).toBe(5);
  });

  it("異常値(0/負/NaN)は宣言が無いのと同じ扱い(毎起動 forceFull を防ぐ)", () => {
    expect(resolveEffectiveSyncBackfillVersion(5, 0)).toBe(5);
    expect(resolveEffectiveSyncBackfillVersion(5, -1)).toBe(5);
    expect(resolveEffectiveSyncBackfillVersion(5, Number.NaN)).toBe(5);
  });
});
