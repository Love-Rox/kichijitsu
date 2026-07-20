import { describe, expect, it } from "vite-plus/test";
import {
  aggregateBlockRules,
  buildBlockRuleRows,
  collectReferencedAccountIds,
  isValidBlockRuleDeleteRequest,
  isValidBlockRuleUpsertRequest,
} from "../src/core/block-rules";

describe("isValidBlockRuleUpsertRequest", () => {
  it("accepts a valid busy request with one source", () => {
    expect(
      isValidBlockRuleUpsertRequest({
        sources: [{ accountId: "acc-1", calendarId: "cal-a" }],
        target: { accountId: "acc-2", calendarId: "cal-b" },
        mode: "busy",
      }),
    ).toBe(true);
  });

  it("accepts a valid outOfOffice request with multiple sources", () => {
    expect(
      isValidBlockRuleUpsertRequest({
        sources: [
          { accountId: "acc-1", calendarId: "cal-a" },
          { accountId: "acc-1", calendarId: "cal-c" },
        ],
        target: { accountId: "acc-2", calendarId: "cal-b" },
        mode: "outOfOffice",
      }),
    ).toBe(true);
  });

  it("accepts an update request with a string id", () => {
    expect(
      isValidBlockRuleUpsertRequest({
        id: "rule-1",
        sources: [{ accountId: "acc-1", calendarId: "cal-a" }],
        target: { accountId: "acc-2", calendarId: "cal-b" },
        mode: "busy",
      }),
    ).toBe(true);
  });

  it("rejects a non-string id", () => {
    expect(
      isValidBlockRuleUpsertRequest({
        id: 42,
        sources: [{ accountId: "acc-1", calendarId: "cal-a" }],
        target: { accountId: "acc-2", calendarId: "cal-b" },
        mode: "busy",
      }),
    ).toBe(false);
  });

  it("rejects an empty sources array", () => {
    expect(
      isValidBlockRuleUpsertRequest({
        sources: [],
        target: { accountId: "acc-2", calendarId: "cal-b" },
        mode: "busy",
      }),
    ).toBe(false);
  });

  it("rejects a non-array sources", () => {
    expect(
      isValidBlockRuleUpsertRequest({
        sources: { accountId: "acc-1", calendarId: "cal-a" },
        target: { accountId: "acc-2", calendarId: "cal-b" },
        mode: "busy",
      }),
    ).toBe(false);
  });

  it("rejects a source with an empty accountId", () => {
    expect(
      isValidBlockRuleUpsertRequest({
        sources: [{ accountId: "", calendarId: "cal-a" }],
        target: { accountId: "acc-2", calendarId: "cal-b" },
        mode: "busy",
      }),
    ).toBe(false);
  });

  it("rejects a source missing calendarId", () => {
    expect(
      isValidBlockRuleUpsertRequest({
        sources: [{ accountId: "acc-1" }],
        target: { accountId: "acc-2", calendarId: "cal-b" },
        mode: "busy",
      }),
    ).toBe(false);
  });

  it("rejects a missing target", () => {
    expect(
      isValidBlockRuleUpsertRequest({
        sources: [{ accountId: "acc-1", calendarId: "cal-a" }],
        mode: "busy",
      }),
    ).toBe(false);
  });

  it("rejects an invalid mode", () => {
    expect(
      isValidBlockRuleUpsertRequest({
        sources: [{ accountId: "acc-1", calendarId: "cal-a" }],
        target: { accountId: "acc-2", calendarId: "cal-b" },
        mode: "invisible",
      }),
    ).toBe(false);
  });

  it("rejects null and non-object bodies", () => {
    expect(isValidBlockRuleUpsertRequest(null)).toBe(false);
    expect(isValidBlockRuleUpsertRequest("not-an-object")).toBe(false);
    expect(isValidBlockRuleUpsertRequest(undefined)).toBe(false);
  });
});

describe("isValidBlockRuleDeleteRequest", () => {
  it("accepts a valid request", () => {
    expect(isValidBlockRuleDeleteRequest({ id: "rule-1" })).toBe(true);
  });

  it("rejects a missing id", () => {
    expect(isValidBlockRuleDeleteRequest({})).toBe(false);
  });

  it("rejects an empty-string id", () => {
    expect(isValidBlockRuleDeleteRequest({ id: "" })).toBe(false);
  });

  it("rejects a non-string id", () => {
    expect(isValidBlockRuleDeleteRequest({ id: 42 })).toBe(false);
  });

  it("rejects null and non-object bodies", () => {
    expect(isValidBlockRuleDeleteRequest(null)).toBe(false);
    expect(isValidBlockRuleDeleteRequest("not-an-object")).toBe(false);
    expect(isValidBlockRuleDeleteRequest(undefined)).toBe(false);
  });
});

describe("buildBlockRuleRows", () => {
  it("builds the rule row and one source row per source", () => {
    const req = {
      sources: [{ accountId: "acc-1", calendarId: "cal-a" }],
      target: { accountId: "acc-2", calendarId: "cal-b" },
      mode: "busy" as const,
    };
    const { ruleRow, sourceRows } = buildBlockRuleRows("rule-1", "profile-1", req, 1000);
    expect(ruleRow).toEqual({
      id: "rule-1",
      profile_id: "profile-1",
      target_account_id: "acc-2",
      target_calendar_id: "cal-b",
      mode: "busy",
      created_at: 1000,
      ooo_fallback: 0,
    });
    expect(sourceRows).toEqual([{ rule_id: "rule-1", account_id: "acc-1", calendar_id: "cal-a" }]);
  });

  it("de-duplicates repeated (accountId, calendarId) sources", () => {
    const req = {
      sources: [
        { accountId: "acc-1", calendarId: "cal-a" },
        { accountId: "acc-1", calendarId: "cal-a" },
        { accountId: "acc-1", calendarId: "cal-c" },
      ],
      target: { accountId: "acc-2", calendarId: "cal-b" },
      mode: "outOfOffice" as const,
    };
    const { sourceRows } = buildBlockRuleRows("rule-1", "profile-1", req, 1000);
    expect(sourceRows).toEqual([
      { rule_id: "rule-1", account_id: "acc-1", calendar_id: "cal-a" },
      { rule_id: "rule-1", account_id: "acc-1", calendar_id: "cal-c" },
    ]);
  });
});

describe("aggregateBlockRules", () => {
  it("groups sources by rule_id into BlockRuleDTO[]", () => {
    const ruleRows = [
      {
        id: "rule-1",
        profile_id: "profile-1",
        target_account_id: "acc-2",
        target_calendar_id: "cal-b",
        mode: "busy" as const,
        created_at: 1000,
        ooo_fallback: 0,
      },
      {
        id: "rule-2",
        profile_id: "profile-1",
        target_account_id: "acc-3",
        target_calendar_id: "cal-c",
        mode: "outOfOffice" as const,
        created_at: 2000,
        ooo_fallback: 1,
      },
    ];
    const sourceRows = [
      { rule_id: "rule-1", account_id: "acc-1", calendar_id: "cal-a" },
      { rule_id: "rule-1", account_id: "acc-1", calendar_id: "cal-d" },
      { rule_id: "rule-2", account_id: "acc-1", calendar_id: "cal-a" },
    ];
    expect(aggregateBlockRules(ruleRows, sourceRows)).toEqual([
      {
        id: "rule-1",
        sources: [
          { accountId: "acc-1", calendarId: "cal-a" },
          { accountId: "acc-1", calendarId: "cal-d" },
        ],
        target: { accountId: "acc-2", calendarId: "cal-b" },
        mode: "busy",
        oooFallback: false,
      },
      {
        id: "rule-2",
        sources: [{ accountId: "acc-1", calendarId: "cal-a" }],
        target: { accountId: "acc-3", calendarId: "cal-c" },
        mode: "outOfOffice",
        oooFallback: true,
      },
    ]);
  });

  it("returns an empty sources array for a rule with no matching source rows", () => {
    const ruleRows = [
      {
        id: "rule-1",
        profile_id: "profile-1",
        target_account_id: "acc-2",
        target_calendar_id: "cal-b",
        mode: "busy" as const,
        created_at: 1000,
        ooo_fallback: 0,
      },
    ];
    expect(aggregateBlockRules(ruleRows, [])).toEqual([
      {
        id: "rule-1",
        sources: [],
        target: { accountId: "acc-2", calendarId: "cal-b" },
        mode: "busy",
        oooFallback: false,
      },
    ]);
  });

  it("returns an empty array for no rules", () => {
    expect(aggregateBlockRules([], [])).toEqual([]);
  });
});

describe("collectReferencedAccountIds", () => {
  it("includes source and target account ids, de-duplicated", () => {
    const req = {
      sources: [
        { accountId: "acc-1", calendarId: "cal-a" },
        { accountId: "acc-2", calendarId: "cal-c" },
      ],
      target: { accountId: "acc-1", calendarId: "cal-b" },
      mode: "busy" as const,
    };
    expect(collectReferencedAccountIds(req)).toEqual(new Set(["acc-1", "acc-2"]));
  });
});
