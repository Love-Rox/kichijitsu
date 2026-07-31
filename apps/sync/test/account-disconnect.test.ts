import { describe, expect, it, vi } from "vite-plus/test";
import {
  disconnectAccounts,
  planBlockRuleCleanup,
  planReconcileTriggers,
  type BlockRuleCleanupInput,
  type BlockRuleCleanupPlan,
  type DisconnectDeps,
  type DisconnectWatchRef,
  type ReconcileTrigger,
} from "../src/core/account-disconnect";

describe("planBlockRuleCleanup", () => {
  const RULE: BlockRuleCleanupInput = {
    id: "rule-1",
    targetAccountId: "acc-target",
    sources: [
      { accountId: "acc-a", calendarId: "cal-a" },
      { accountId: "acc-b", calendarId: "cal-b" },
    ],
  };

  it("deletes the whole rule when the target account is disconnected", () => {
    // 書き込み先が消えた以上ルールは成立しない。source を外す話にはならない。
    expect(planBlockRuleCleanup(["acc-target"], [RULE])).toEqual({
      ruleIdsToDelete: ["rule-1"],
      sourcesToDetach: [],
    });
  });

  it("detaches only the disconnected source when other sources remain", () => {
    expect(planBlockRuleCleanup(["acc-a"], [RULE])).toEqual({
      ruleIdsToDelete: [],
      sourcesToDetach: [{ ruleId: "rule-1", accountId: "acc-a", calendarId: "cal-a" }],
    });
  });

  it("deletes the rule when every source is disconnected (a rule with no source is meaningless)", () => {
    expect(planBlockRuleCleanup(["acc-a", "acc-b"], [RULE])).toEqual({
      ruleIdsToDelete: ["rule-1"],
      sourcesToDetach: [],
    });
  });

  it("detaches every disconnected source of a rule, not just the first", () => {
    const rule: BlockRuleCleanupInput = {
      id: "rule-1",
      targetAccountId: "acc-target",
      sources: [
        { accountId: "acc-a", calendarId: "cal-a1" },
        { accountId: "acc-a", calendarId: "cal-a2" },
        { accountId: "acc-b", calendarId: "cal-b" },
      ],
    };
    expect(planBlockRuleCleanup(["acc-a"], [rule]).sourcesToDetach).toEqual([
      { ruleId: "rule-1", accountId: "acc-a", calendarId: "cal-a1" },
      { ruleId: "rule-1", accountId: "acc-a", calendarId: "cal-a2" },
    ]);
  });

  it("deletes the rule once when the account is both target and source (no leftover detach)", () => {
    const rule: BlockRuleCleanupInput = {
      id: "rule-1",
      targetAccountId: "acc-a",
      sources: [
        { accountId: "acc-a", calendarId: "cal-a" },
        { accountId: "acc-b", calendarId: "cal-b" },
      ],
    };
    expect(planBlockRuleCleanup(["acc-a"], [rule])).toEqual({
      ruleIdsToDelete: ["rule-1"],
      sourcesToDetach: [],
    });
  });

  it("leaves rules that reference only still-connected accounts alone", () => {
    expect(planBlockRuleCleanup(["acc-other"], [RULE])).toEqual({
      ruleIdsToDelete: [],
      sourcesToDetach: [],
    });
  });

  it("returns an empty plan when nothing is disconnected", () => {
    expect(planBlockRuleCleanup([], [RULE])).toEqual({ ruleIdsToDelete: [], sourcesToDetach: [] });
  });

  it("handles a bundle disconnect: rules are judged against all disconnected accounts at once", () => {
    // オーナー解除は束ごと (resolveDisconnectTargets)。acc-a 単独では生き残るルールでも、
    // acc-b も同時に解除されるなら source が0件になるのでルールごと消える。
    const rules: BlockRuleCleanupInput[] = [
      RULE,
      { id: "rule-2", targetAccountId: "acc-b", sources: [{ accountId: "acc-c", calendarId: "c" }] },
    ];
    expect(planBlockRuleCleanup(["acc-a", "acc-b"], rules)).toEqual({
      ruleIdsToDelete: ["rule-1", "rule-2"],
      sourcesToDetach: [],
    });
  });
});

/**
 * 解除後に自分でリコンサイルを起こす判断 (A-3)。リコンサイルの唯一の入口は source への
 * 変更通知であり、解除されたカレンダーは二度と発火しない — だから残っている source を
 * 起点に選ぶ。
 */
describe("planReconcileTriggers", () => {
  const RULE: BlockRuleCleanupInput = {
    id: "rule-1",
    targetAccountId: "acc-target",
    sources: [
      { accountId: "acc-a", calendarId: "cal-a" },
      { accountId: "acc-b", calendarId: "cal-b" },
    ],
  };

  it("生き残るルールについて、残っている source を起点に選ぶ", () => {
    expect(planReconcileTriggers(["acc-a"], [RULE])).toEqual([
      { accountId: "acc-b", calendarId: "cal-b" },
    ]);
  });

  it("target が解除されたルールは起こさない (ルールごと消えるので起こす意味が無い)", () => {
    expect(planReconcileTriggers(["acc-target"], [RULE])).toEqual([]);
  });

  it("全 source が解除されたルールは起こさない (ルールごと消える)", () => {
    expect(planReconcileTriggers(["acc-a", "acc-b"], [RULE])).toEqual([]);
  });

  it("何も外れなかったルールは起こさない", () => {
    expect(planReconcileTriggers(["acc-other"], [RULE])).toEqual([]);
  });

  it("同じ source を複数ルールが共有していても1回だけ起こす", () => {
    // 1回のリコンサイルはその source を持つ全ルールを見るので、重複は無駄なだけ。
    const rules: BlockRuleCleanupInput[] = [
      RULE,
      {
        id: "rule-2",
        targetAccountId: "acc-target2",
        sources: [
          { accountId: "acc-a", calendarId: "cal-a" },
          { accountId: "acc-b", calendarId: "cal-b" },
        ],
      },
    ];
    expect(planReconcileTriggers(["acc-a"], rules)).toEqual([
      { accountId: "acc-b", calendarId: "cal-b" },
    ]);
  });

  it("何も解除されていなければ空", () => {
    expect(planReconcileTriggers([], [RULE])).toEqual([]);
  });
});

/** 呼ばれた副作用を順番に記録するデバッグ用の deps。テストごとに必要なものを上書きする。 */
function makeDeps(
  calls: string[],
  overrides: Partial<DisconnectDeps> = {},
): DisconnectDeps & { appliedPlans: BlockRuleCleanupPlan[] } {
  const appliedPlans: BlockRuleCleanupPlan[] = [];
  const base: DisconnectDeps = {
    listWatches: vi.fn(async (accountId: string): Promise<DisconnectWatchRef[]> => {
      calls.push(`listWatches:${accountId}`);
      return [{ channelId: `ch-${accountId}`, calendarId: "primary" }];
    }),
    stopWatch: vi.fn(async (accountId: string, watch: DisconnectWatchRef) => {
      calls.push(`stopWatch:${accountId}:${watch.calendarId}`);
    }),
    revokeToken: vi.fn(async (accountId: string) => {
      calls.push(`revokeToken:${accountId}`);
    }),
    clearSyncState: vi.fn(async (accountId: string) => {
      calls.push(`clearSyncState:${accountId}`);
    }),
    deleteAccountRows: vi.fn(async (accountId: string) => {
      calls.push(`deleteAccountRows:${accountId}`);
    }),
    loadBlockRules: vi.fn(async () => {
      calls.push("loadBlockRules");
      return [];
    }),
    applyBlockRuleCleanup: vi.fn(async (plan: BlockRuleCleanupPlan) => {
      calls.push("applyBlockRuleCleanup");
      appliedPlans.push(plan);
    }),
    reconcileFromSource: vi.fn(async (trigger: ReconcileTrigger) => {
      calls.push(`reconcileFromSource:${trigger.accountId}:${trigger.calendarId}`);
    }),
    ...overrides,
  };
  return Object.assign(base, { appliedPlans });
}

describe("disconnectAccounts", () => {
  it("stops watches before revoking (channels.stop needs a live access token)", async () => {
    const calls: string[] = [];
    await disconnectAccounts(["acc-1"], makeDeps(calls));

    expect(calls).toEqual([
      "listWatches:acc-1",
      "stopWatch:acc-1:primary",
      "revokeToken:acc-1",
      "clearSyncState:acc-1",
      "deleteAccountRows:acc-1",
      "loadBlockRules",
    ]);
  });

  it("stops every watch channel the account had", async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls, {
      listWatches: async () => [
        { channelId: "ch-1", calendarId: "primary" },
        { channelId: "ch-2", calendarId: "work" },
      ],
    });
    await disconnectAccounts(["acc-1"], deps);

    expect(deps.stopWatch).toHaveBeenCalledTimes(2);
    expect(calls).toContain("stopWatch:acc-1:primary");
    expect(calls).toContain("stopWatch:acc-1:work");
  });

  it("still deletes the rows when stopping the watch fails (best-effort)", async () => {
    // stop の失敗で解除全体を失敗させると、利用者が「解除できない」状態に閉じ込められる。
    const calls: string[] = [];
    const deps = makeDeps(calls, {
      stopWatch: vi.fn(async () => {
        throw new Error("google is down");
      }),
    });
    await disconnectAccounts(["acc-1"], deps);

    expect(calls).toContain("revokeToken:acc-1");
    expect(calls).toContain("deleteAccountRows:acc-1");
  });

  it("still deletes the rows when listing watches, revoke, or DO clear fails", async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls, {
      listWatches: vi.fn(async () => {
        throw new Error("d1 is down");
      }),
      revokeToken: vi.fn(async () => {
        throw new Error("revoke failed");
      }),
      clearSyncState: vi.fn(async () => {
        throw new Error("DO unreachable");
      }),
    });
    await disconnectAccounts(["acc-1"], deps);

    expect(deps.stopWatch).not.toHaveBeenCalled();
    expect(calls).toContain("deleteAccountRows:acc-1");
  });

  it("processes every target account of a bundle (owner disconnect)", async () => {
    const calls: string[] = [];
    await disconnectAccounts(["acc-1", "acc-2"], makeDeps(calls));

    expect(calls).toEqual([
      "listWatches:acc-1",
      "stopWatch:acc-1:primary",
      "revokeToken:acc-1",
      "clearSyncState:acc-1",
      "deleteAccountRows:acc-1",
      "listWatches:acc-2",
      "stopWatch:acc-2:primary",
      "revokeToken:acc-2",
      "clearSyncState:acc-2",
      "deleteAccountRows:acc-2",
      "loadBlockRules",
    ]);
  });

  it("cleans block rules once, judging against all disconnected accounts", async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls, {
      loadBlockRules: async () => [
        {
          id: "rule-1",
          targetAccountId: "acc-keep",
          sources: [
            { accountId: "acc-1", calendarId: "cal-1" },
            { accountId: "acc-keep", calendarId: "cal-keep" },
          ],
        },
        {
          id: "rule-2",
          targetAccountId: "acc-2",
          sources: [{ accountId: "acc-keep", calendarId: "x" }],
        },
      ],
    });
    await disconnectAccounts(["acc-1", "acc-2"], deps);

    expect(deps.applyBlockRuleCleanup).toHaveBeenCalledTimes(1);
    expect(deps.appliedPlans[0]).toEqual({
      ruleIdsToDelete: ["rule-2"],
      sourcesToDetach: [{ ruleId: "rule-1", accountId: "acc-1", calendarId: "cal-1" }],
    });
  });

  /**
   * 回帰 (A-3): 以前は「残ったミラーは次回のリコンサイルで削除計画に載る」とコメントが
   * 主張していたが、そのリコンサイルを起こす者が居なかった。解除されたカレンダーはもう
   * 変更通知を出さないので、無関係な別 source がたまたま変わるまでミラーが残り続けていた。
   */
  it("生き残ったルールについて、掃除の後にリコンサイルを起こす (外したカレンダー由来のミラーを片付ける)", async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls, {
      loadBlockRules: async () => [
        {
          id: "rule-1",
          targetAccountId: "acc-keep",
          sources: [
            { accountId: "acc-1", calendarId: "cal-1" },
            { accountId: "acc-keep", calendarId: "cal-keep" },
          ],
        },
      ],
    });
    await disconnectAccounts(["acc-1"], deps);

    // D1 の掃除より後であること: 先に起こすと、まだ外れていない解除済み source を読みに行って失敗する。
    expect(calls.slice(-2)).toEqual([
      "applyBlockRuleCleanup",
      "reconcileFromSource:acc-keep:cal-keep",
    ]);
  });

  it("リコンサイルの起動に失敗しても解除は成立させる (best-effort)", async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls, {
      loadBlockRules: async () => [
        {
          id: "rule-1",
          targetAccountId: "acc-keep",
          sources: [
            { accountId: "acc-1", calendarId: "cal-1" },
            { accountId: "acc-keep", calendarId: "cal-keep" },
          ],
        },
      ],
      reconcileFromSource: vi.fn(async () => {
        throw new Error("DO unreachable");
      }),
    });

    await expect(disconnectAccounts(["acc-1"], deps)).resolves.toBeUndefined();
    expect(deps.reconcileFromSource).toHaveBeenCalledWith({
      accountId: "acc-keep",
      calendarId: "cal-keep",
    });
    expect(calls).toContain("applyBlockRuleCleanup");
  });

  it("ルールごと消える解除ではリコンサイルを起こさない", async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls, {
      loadBlockRules: async () => [
        {
          id: "rule-1",
          targetAccountId: "acc-1",
          sources: [{ accountId: "acc-keep", calendarId: "cal-keep" }],
        },
      ],
    });
    await disconnectAccounts(["acc-1"], deps);

    expect(deps.reconcileFromSource).not.toHaveBeenCalled();
  });

  it("skips the cleanup write when no rule is affected (no empty D1 batch)", async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls, {
      loadBlockRules: async () => [
        {
          id: "rule-1",
          targetAccountId: "acc-keep",
          sources: [{ accountId: "acc-keep", calendarId: "c" }],
        },
      ],
    });
    await disconnectAccounts(["acc-1"], deps);

    expect(deps.applyBlockRuleCleanup).not.toHaveBeenCalled();
  });
});
