import type { GoogleEventDTO } from "@kichijitsu/shared";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  reconcileSourceChange,
  type ReconcileDeps,
  type ReconcileRule,
  type ReconcileWindow,
} from "../src/core/block-orchestrate";
import type { BlockMirrorRow } from "../src/core/block-reconcile";

const WINDOW: ReconcileWindow = {
  timeMin: "2026-07-19T00:00:00.000Z",
  timeMax: "2026-09-17T00:00:00.000Z",
};

function timedEvent(overrides: Partial<GoogleEventDTO> = {}): GoogleEventDTO {
  return {
    id: "ev-1",
    status: "confirmed",
    start: { dateTime: "2026-07-20T10:00:00+09:00", timeZone: "Asia/Tokyo" },
    end: { dateTime: "2026-07-20T11:00:00+09:00", timeZone: "Asia/Tokyo" },
    updated: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

function mirrorRow(overrides: Partial<BlockMirrorRow> = {}): BlockMirrorRow {
  return {
    rule_id: "rule-1",
    source_event_id: "ev-1",
    mirror_event_id: "mirror-1",
    source_updated: "2026-07-19T00:00:00.000Z",
    created_at: 1000,
    ...overrides,
  };
}

function makeRule(overrides: Partial<ReconcileRule> = {}): ReconcileRule {
  return {
    id: "rule-1",
    sources: [{ accountId: "src-acc", calendarId: "src-cal" }],
    target: { accountId: "tgt-acc", calendarId: "tgt-cal" },
    mode: "busy",
    ...overrides,
  };
}

/** すべてのフックを no-op のモックにした ReconcileDeps。テストごとに必要なものを上書きする。 */
function makeDeps(overrides: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    loadRulesForSource: vi.fn(async () => []),
    listSourceEvents: vi.fn(async () => []),
    loadMirrors: vi.fn(async () => []),
    createMirror: vi.fn(async () => ({ id: "mirror-new", oooFallback: false })),
    patchMirrorTime: vi.fn(async () => {}),
    deleteMirror: vi.fn(async () => {}),
    saveMirrorRow: vi.fn(async () => {}),
    updateMirrorRow: vi.fn(async () => {}),
    deleteMirrorRow: vi.fn(async () => {}),
    setRuleOooFallback: vi.fn(async () => {}),
    now: vi.fn(() => 5000),
    ...overrides,
  };
}

describe("reconcileSourceChange", () => {
  it("does nothing when there are no rules for the source", async () => {
    const deps = makeDeps({ loadRulesForSource: vi.fn(async () => []) });
    await reconcileSourceChange("acc", "cal", WINDOW, deps);
    expect(deps.listSourceEvents).not.toHaveBeenCalled();
  });

  it("creates a mirror for a new source event and saves the mirror row with correct fields", async () => {
    const source = timedEvent({ id: "ev-new", updated: "2026-07-20T01:00:00.000Z" });
    const rule = makeRule();
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [rule]),
      listSourceEvents: vi.fn(async () => [source]),
      loadMirrors: vi.fn(async () => []),
      createMirror: vi.fn(async () => ({ id: "mirror-created-id", oooFallback: false })),
      now: vi.fn(() => 9999),
    });

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

    expect(deps.createMirror).toHaveBeenCalledWith(
      "tgt-acc",
      "tgt-cal",
      expect.objectContaining({ summary: "予定あり" }),
    );
    expect(deps.saveMirrorRow).toHaveBeenCalledWith({
      rule_id: "rule-1",
      source_event_id: "ev-new",
      mirror_event_id: "mirror-created-id",
      source_updated: "2026-07-20T01:00:00.000Z",
      created_at: 9999,
    });
  });

  it("reflects the rule's mode (outOfOffice) in the body passed to createMirror", async () => {
    const source = timedEvent();
    const rule = makeRule({ mode: "outOfOffice" });
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [rule]),
      listSourceEvents: vi.fn(async () => [source]),
    });

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

    expect(deps.createMirror).toHaveBeenCalledWith(
      "tgt-acc",
      "tgt-cal",
      expect.objectContaining({ eventType: "outOfOffice" }),
    );
  });

  it("does not save the mirror row when createMirror throws (avoids inconsistency)", async () => {
    const source = timedEvent();
    const rule = makeRule();
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [rule]),
      listSourceEvents: vi.fn(async () => [source]),
      createMirror: vi.fn(async () => {
        throw new Error("google insert failed");
      }),
    });

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

    expect(deps.saveMirrorRow).not.toHaveBeenCalled();
  });

  it("patches the mirror's time and updates the mirror row when the source's updated changed", async () => {
    const source = timedEvent({
      id: "ev-patched",
      updated: "2026-07-20T09:00:00.000Z",
      start: { dateTime: "2026-07-21T10:00:00+09:00", timeZone: "Asia/Tokyo" },
      end: { dateTime: "2026-07-21T11:00:00+09:00", timeZone: "Asia/Tokyo" },
    });
    const mirror = mirrorRow({
      source_event_id: "ev-patched",
      mirror_event_id: "mirror-patched",
      source_updated: "2026-07-19T00:00:00.000Z",
    });
    const rule = makeRule();
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [rule]),
      listSourceEvents: vi.fn(async () => [source]),
      loadMirrors: vi.fn(async () => [mirror]),
    });

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

    expect(deps.patchMirrorTime).toHaveBeenCalledWith(
      "tgt-acc",
      "tgt-cal",
      "mirror-patched",
      source.start,
      source.end,
    );
    expect(deps.updateMirrorRow).toHaveBeenCalledWith(
      "rule-1",
      "ev-patched",
      "2026-07-20T09:00:00.000Z",
    );
  });

  it("does not update the mirror row when patchMirrorTime throws", async () => {
    const source = timedEvent({ updated: "2026-07-20T09:00:00.000Z" });
    const mirror = mirrorRow({ source_updated: "2026-07-19T00:00:00.000Z" });
    const rule = makeRule();
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [rule]),
      listSourceEvents: vi.fn(async () => [source]),
      loadMirrors: vi.fn(async () => [mirror]),
      patchMirrorTime: vi.fn(async () => {
        throw new Error("google patch failed");
      }),
    });

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

    expect(deps.updateMirrorRow).not.toHaveBeenCalled();
  });

  it("deletes the mirror and its row when the source disappears", async () => {
    const mirror = mirrorRow({ mirror_event_id: "mirror-gone" });
    const rule = makeRule();
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [rule]),
      listSourceEvents: vi.fn(async () => []),
      loadMirrors: vi.fn(async () => [mirror]),
    });

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

    expect(deps.deleteMirror).toHaveBeenCalledWith("tgt-acc", "tgt-cal", "mirror-gone");
    expect(deps.deleteMirrorRow).toHaveBeenCalledWith("rule-1", "ev-1");
  });

  it("deletes the mirror and its row when the source is cancelled", async () => {
    const source = timedEvent({ status: "cancelled" });
    const mirror = mirrorRow();
    const rule = makeRule();
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [rule]),
      listSourceEvents: vi.fn(async () => [source]),
      loadMirrors: vi.fn(async () => [mirror]),
    });

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

    expect(deps.deleteMirror).toHaveBeenCalledWith("tgt-acc", "tgt-cal", "mirror-1");
    expect(deps.deleteMirrorRow).toHaveBeenCalledWith("rule-1", "ev-1");
  });

  it("does not delete the mirror row when deleteMirror throws", async () => {
    const mirror = mirrorRow();
    const rule = makeRule();
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [rule]),
      listSourceEvents: vi.fn(async () => []),
      loadMirrors: vi.fn(async () => [mirror]),
      deleteMirror: vi.fn(async () => {
        throw new Error("google delete failed");
      }),
    });

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

    expect(deps.deleteMirrorRow).not.toHaveBeenCalled();
  });

  it("combines events from multiple source calendars for a single rule", async () => {
    const eventA = timedEvent({ id: "ev-a" });
    const eventB = timedEvent({ id: "ev-b" });
    const rule = makeRule({
      sources: [
        { accountId: "acc-a", calendarId: "cal-a" },
        { accountId: "acc-b", calendarId: "cal-b" },
      ],
    });
    const listSourceEvents = vi.fn(async (accountId: string) =>
      accountId === "acc-a" ? [eventA] : [eventB],
    );
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [rule]),
      listSourceEvents,
    });

    await reconcileSourceChange("acc-a", "cal-a", WINDOW, deps);

    expect(listSourceEvents).toHaveBeenCalledWith("acc-a", "cal-a", WINDOW);
    expect(listSourceEvents).toHaveBeenCalledWith("acc-b", "cal-b", WINDOW);
    // 2 つの source カレンダーから来たイベントが 1 ルールとして結合され、それぞれ mirror 作成される。
    expect(deps.createMirror).toHaveBeenCalledTimes(2);
  });

  it("processes multiple rules independently, isolating one rule's failure from another", async () => {
    const sourceA = timedEvent({ id: "ev-a" });
    const sourceB = timedEvent({ id: "ev-b" });
    const ruleFailing = makeRule({
      id: "rule-fail",
      target: { accountId: "tgt-fail", calendarId: "cal-fail" },
    });
    const ruleOk = makeRule({
      id: "rule-ok",
      target: { accountId: "tgt-ok", calendarId: "cal-ok" },
    });

    const listSourceEvents = vi.fn(async () => [sourceA, sourceB]);
    const createMirror = vi.fn(async (targetAccountId: string) => {
      if (targetAccountId === "tgt-fail") {
        throw new Error("boom");
      }
      return { id: "mirror-ok", oooFallback: false };
    });
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [ruleFailing, ruleOk]),
      listSourceEvents,
      createMirror,
    });

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

    // rule-ok の2件は saveMirrorRow まで到達しているはず (rule-fail の失敗に巻き込まれない)。
    expect(deps.saveMirrorRow).toHaveBeenCalledTimes(2);
    expect(deps.saveMirrorRow).toHaveBeenCalledWith(
      expect.objectContaining({ rule_id: "rule-ok", mirror_event_id: "mirror-ok" }),
    );
  });

  it("continues processing other rules when loadMirrors throws for one rule", async () => {
    const source = timedEvent();
    const ruleFailing = makeRule({ id: "rule-fail" });
    const ruleOk = makeRule({ id: "rule-ok" });
    let call = 0;
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [ruleFailing, ruleOk]),
      listSourceEvents: vi.fn(async () => [source]),
      loadMirrors: vi.fn(async () => {
        call++;
        if (call === 1) throw new Error("d1 failure");
        return [];
      }),
    });

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

    expect(deps.createMirror).toHaveBeenCalledTimes(1);
    expect(deps.saveMirrorRow).toHaveBeenCalledWith(
      expect.objectContaining({ rule_id: "rule-ok" }),
    );
  });

  it("returns without throwing when loadRulesForSource itself throws", async () => {
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => {
        throw new Error("d1 down");
      }),
    });

    await expect(reconcileSourceChange("acc", "cal", WINDOW, deps)).resolves.toBeUndefined();
  });

  describe("outOfOffice fallback flag (docs/blocking.md 第4段階)", () => {
    it("records ooo_fallback=true when the single toCreate item falls back to busy", async () => {
      const source = timedEvent();
      const rule = makeRule({ mode: "outOfOffice" });
      const deps = makeDeps({
        loadRulesForSource: vi.fn(async () => [rule]),
        listSourceEvents: vi.fn(async () => [source]),
        createMirror: vi.fn(async () => ({ id: "mirror-fb", oooFallback: true })),
      });

      await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

      expect(deps.setRuleOooFallback).toHaveBeenCalledWith("rule-1", true);
    });

    it("records ooo_fallback=false when all toCreate items succeed without falling back", async () => {
      const source = timedEvent();
      const rule = makeRule({ mode: "outOfOffice" });
      const deps = makeDeps({
        loadRulesForSource: vi.fn(async () => [rule]),
        listSourceEvents: vi.fn(async () => [source]),
        createMirror: vi.fn(async () => ({ id: "mirror-ok", oooFallback: false })),
      });

      await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

      expect(deps.setRuleOooFallback).toHaveBeenCalledWith("rule-1", false);
    });

    it("does not call setRuleOooFallback for a busy-mode rule with toCreate items", async () => {
      const source = timedEvent();
      const rule = makeRule({ mode: "busy" });
      const deps = makeDeps({
        loadRulesForSource: vi.fn(async () => [rule]),
        listSourceEvents: vi.fn(async () => [source]),
      });

      await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

      expect(deps.setRuleOooFallback).not.toHaveBeenCalled();
    });

    it("does not call setRuleOooFallback for an outOfOffice rule when toCreate is empty", async () => {
      const mirror = mirrorRow();
      const rule = makeRule({ mode: "outOfOffice" });
      const deps = makeDeps({
        loadRulesForSource: vi.fn(async () => [rule]),
        // source と mirror が既に一致しているので toCreate は空 (toPatch/toDelete も空)。
        listSourceEvents: vi.fn(async () => [timedEvent()]),
        loadMirrors: vi.fn(async () => [mirror]),
      });

      await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

      expect(deps.setRuleOooFallback).not.toHaveBeenCalled();
    });

    it("records ooo_fallback=true when any of two toCreate items falls back (any-true wins)", async () => {
      const eventA = timedEvent({ id: "ev-a" });
      const eventB = timedEvent({ id: "ev-b" });
      const rule = makeRule({ mode: "outOfOffice" });
      // toCreate の順序どおりに呼ばれる (block-reconcile.ts の reconcileBlockRule は
      // source 配列の順序を保つ) ことを前提に、呼び出しごとの結果をキューから取り出す。
      const results = [
        { id: "mirror-a", oooFallback: false },
        { id: "mirror-b", oooFallback: true },
      ];
      const createMirror = vi.fn(async () => results.shift()!);
      const deps = makeDeps({
        loadRulesForSource: vi.fn(async () => [rule]),
        listSourceEvents: vi.fn(async () => [eventA, eventB]),
        createMirror,
      });

      await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

      expect(createMirror).toHaveBeenCalledTimes(2);
      expect(deps.setRuleOooFallback).toHaveBeenCalledWith("rule-1", true);
    });
  });
});
