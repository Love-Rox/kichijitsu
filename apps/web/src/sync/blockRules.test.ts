import { describe, expect, it } from "vite-plus/test";
import type { BlockRuleDTO } from "@kichijitsu/shared";
import {
  blockModeLabel,
  buildBlockRuleDeleteRequest,
  buildBlockRuleUpsertRequest,
  describeBlockRule,
  resolveCalendarName,
} from "./blockRules";

describe("buildBlockRuleUpsertRequest", () => {
  it("id 省略時は id 無しのリクエストを組み立てる(新規作成)", () => {
    const sources = [{ accountId: "acc-1", calendarId: "cal-a" }];
    const target = { accountId: "acc-1", calendarId: "cal-b" };
    const req = buildBlockRuleUpsertRequest(sources, target, "busy");
    expect(req.id).toBeUndefined();
    expect(req).toMatchObject({ sources, target, mode: "busy" });
  });

  it("id 指定時はそのまま id を含める(更新)", () => {
    const sources = [{ accountId: "acc-1", calendarId: "cal-a" }];
    const target = { accountId: "acc-1", calendarId: "cal-b" };
    const req = buildBlockRuleUpsertRequest(sources, target, "outOfOffice", "rule-1");
    expect(req).toEqual({ id: "rule-1", sources, target, mode: "outOfOffice" });
  });

  it("複数 source をそのまま配列で渡す", () => {
    const sources = [
      { accountId: "acc-1", calendarId: "cal-a" },
      { accountId: "acc-2", calendarId: "cal-c" },
    ];
    const target = { accountId: "acc-1", calendarId: "cal-b" };
    const req = buildBlockRuleUpsertRequest(sources, target, "busy");
    expect(req.sources).toEqual(sources);
  });
});

describe("buildBlockRuleDeleteRequest", () => {
  it("id をそのまま BlockRuleDeleteRequest に詰める", () => {
    expect(buildBlockRuleDeleteRequest("rule-1")).toEqual({ id: "rule-1" });
  });
});

describe("blockModeLabel", () => {
  it("busy は「予定あり」", () => {
    expect(blockModeLabel("busy")).toBe("予定あり");
  });

  it("outOfOffice は「不在」", () => {
    expect(blockModeLabel("outOfOffice")).toBe("不在");
  });
});

describe("resolveCalendarName", () => {
  const calendarsByAccount = {
    "acc-1": [
      { id: "cal-a", summary: "仕事", primary: true },
      { id: "cal-b", summary: "プライベート" },
    ],
  };

  it("該当エントリがあればその summary を返す", () => {
    expect(resolveCalendarName(calendarsByAccount, "acc-1", "cal-a")).toBe("仕事");
  });

  it("アカウントは存在するがカレンダーが見つからなければ calendarId をそのまま返す", () => {
    expect(resolveCalendarName(calendarsByAccount, "acc-1", "cal-unknown")).toBe("cal-unknown");
  });

  it("アカウント自体が calendarsByAccount に無ければ calendarId をそのまま返す", () => {
    expect(resolveCalendarName(calendarsByAccount, "acc-unknown", "cal-x")).toBe("cal-x");
  });

  it("calendarsByAccount が空でも壊れない", () => {
    expect(resolveCalendarName({}, "acc-1", "cal-a")).toBe("cal-a");
  });
});

describe("describeBlockRule", () => {
  const calendarsByAccount = {
    "acc-1": [
      { id: "cal-a", summary: "仕事", primary: true },
      { id: "cal-b", summary: "プライベート" },
    ],
    "acc-2": [{ id: "cal-c", summary: "サブ" }],
  };

  it("sources 複数・target 単一を名前解決して整形する", () => {
    const rule: BlockRuleDTO = {
      id: "rule-1",
      sources: [
        { accountId: "acc-1", calendarId: "cal-a" },
        { accountId: "acc-2", calendarId: "cal-c" },
      ],
      target: { accountId: "acc-1", calendarId: "cal-b" },
      mode: "busy",
      oooFallback: false,
    };
    expect(describeBlockRule(rule, calendarsByAccount)).toEqual({
      id: "rule-1",
      sourceNames: ["仕事", "サブ"],
      targetName: "プライベート",
      modeLabel: "予定あり",
      oooFallback: false,
    });
  });

  it("未知の calendarId は id のままフォールバックする", () => {
    const rule: BlockRuleDTO = {
      id: "rule-2",
      sources: [{ accountId: "acc-1", calendarId: "cal-deleted" }],
      target: { accountId: "acc-1", calendarId: "cal-b" },
      mode: "outOfOffice",
      oooFallback: false,
    };
    expect(describeBlockRule(rule, calendarsByAccount)).toEqual({
      id: "rule-2",
      sourceNames: ["cal-deleted"],
      targetName: "プライベート",
      modeLabel: "不在",
      oooFallback: false,
    });
  });

  it("outOfOffice かつ oooFallback: true のとき display の oooFallback は true", () => {
    const rule: BlockRuleDTO = {
      id: "rule-3",
      sources: [{ accountId: "acc-1", calendarId: "cal-a" }],
      target: { accountId: "acc-1", calendarId: "cal-b" },
      mode: "outOfOffice",
      oooFallback: true,
    };
    expect(describeBlockRule(rule, calendarsByAccount).oooFallback).toBe(true);
  });

  it("outOfOffice かつ oooFallback: false のとき display の oooFallback は false", () => {
    const rule: BlockRuleDTO = {
      id: "rule-4",
      sources: [{ accountId: "acc-1", calendarId: "cal-a" }],
      target: { accountId: "acc-1", calendarId: "cal-b" },
      mode: "outOfOffice",
      oooFallback: false,
    };
    expect(describeBlockRule(rule, calendarsByAccount).oooFallback).toBe(false);
  });

  it("busy モードで oooFallback: true でも display の oooFallback は false (busy には無関係)", () => {
    const rule: BlockRuleDTO = {
      id: "rule-5",
      sources: [{ accountId: "acc-1", calendarId: "cal-a" }],
      target: { accountId: "acc-1", calendarId: "cal-b" },
      mode: "busy",
      oooFallback: true,
    };
    expect(describeBlockRule(rule, calendarsByAccount).oooFallback).toBe(false);
  });
});
