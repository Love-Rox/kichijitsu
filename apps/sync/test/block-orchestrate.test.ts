import type { GoogleEventDTO } from "@kichijitsu/shared";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  deleteRuleMirrors,
  reconcileSourceChange,
  type ReconcileDeps,
  type ReconcileRule,
  type ReconcileWindow,
} from "../src/core/block-orchestrate";
import {
  MIRROR_MARKER_KEY,
  MIRROR_RULE_KEY,
  MIRROR_SOURCE_KEY,
  type BlockMirrorRow,
  type MirrorEventBody,
} from "../src/core/block-reconcile";

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
    listTargetEvents: vi.fn(async () => []),
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

/**
 * ミラー作成の不変条件 (block-orchestrate.ts の reconcileRule の doc):
 * *Google 上にミラーが存在するなら、それを指す行が残っているか、確実に消えているか*。
 *
 * 回帰の中身: 以前は createMirror と saveMirrorRow が1つの try に入っていたため、insert 成功後の
 * D1 書き込み失敗で「行の無いミラー」が残り、後始末の経路 (block_mirrors を走査する) から
 * 二度と辿れないまま、次のリコンサイルが同じ source をまた作り直して**毎回1件ずつ増えていた**。
 */
describe("ミラー作成の不変条件 (孤児を作らない・増やさない)", () => {
  /** target カレンダーを模したフェイク。作られた mirror を由来つきで保持し、一覧/削除できる。 */
  function makeMirrorCalendar(options: { deleteAlwaysFails?: boolean } = {}) {
    const events = new Map<string, GoogleEventDTO>();
    let seq = 0;
    return {
      events,
      createMirror: vi.fn(async (_a: string, _c: string, body: MirrorEventBody) => {
        const id = `mirror-${++seq}`;
        events.set(id, {
          id,
          status: "confirmed",
          start: body.start,
          end: body.end,
          extendedProperties: { private: { ...body.extendedProperties.private } },
        });
        return { id, oooFallback: false };
      }),
      deleteMirror: vi.fn(async (_a: string, _c: string, mirrorEventId: string) => {
        if (options.deleteAlwaysFails) throw new Error("google delete failed");
        if (!events.delete(mirrorEventId)) throw new Error("404 notFound");
      }),
      listTargetEvents: vi.fn(async () => [...events.values()]),
    };
  }

  /** block_mirrors を模した対応表。saveMirrorRow を任意の回だけ失敗させられる。 */
  function makeMirrorRows(failingSaves: number) {
    const rows = new Map<string, BlockMirrorRow>();
    let remainingFailures = failingSaves;
    return {
      rows,
      loadMirrors: vi.fn(async () => [...rows.values()]),
      saveMirrorRow: vi.fn(async (row: BlockMirrorRow) => {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error("d1 write failed");
        }
        rows.set(row.source_event_id, row);
      }),
    };
  }

  it("行が書けなかったら、作ったばかりのミラーを Google から消す (孤児にしない)", async () => {
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [makeRule()]),
      listSourceEvents: vi.fn(async () => [timedEvent()]),
      createMirror: vi.fn(async () => ({ id: "mirror-created", oooFallback: false })),
      saveMirrorRow: vi.fn(async () => {
        throw new Error("d1 write failed");
      }),
    });

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

    expect(deps.deleteMirror).toHaveBeenCalledWith("tgt-acc", "tgt-cal", "mirror-created");
  });

  it("補償削除も失敗したときに例外を投げない (他の操作・他ルールを巻き込まない)", async () => {
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [makeRule()]),
      listSourceEvents: vi.fn(async () => [timedEvent()]),
      saveMirrorRow: vi.fn(async () => {
        throw new Error("d1 write failed");
      }),
      deleteMirror: vi.fn(async () => {
        throw new Error("google delete failed");
      }),
    });

    await expect(reconcileSourceChange("src-acc", "src-cal", WINDOW, deps)).resolves.toBeUndefined();
  });

  it("D1 書き込みが落ちた回のミラーは巻き戻り、次のリコンサイルで1件だけ作り直される", async () => {
    const google = makeMirrorCalendar();
    const table = makeMirrorRows(1); // 1回目の saveMirrorRow だけ失敗する
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [makeRule()]),
      listSourceEvents: vi.fn(async () => [timedEvent()]),
      loadMirrors: table.loadMirrors,
      saveMirrorRow: table.saveMirrorRow,
      createMirror: google.createMirror,
      deleteMirror: google.deleteMirror,
      listTargetEvents: google.listTargetEvents,
    });

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);
    // 補償削除で「行も予定も無い」状態に戻っている。
    expect(google.events.size).toBe(0);
    expect(table.rows.size).toBe(0);

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);
    expect(google.events.size).toBe(1);
    expect(table.rows.size).toBe(1);
  });

  it("補償削除まで失敗して孤児が残っても、次のリコンサイルが採用して二重にしない", async () => {
    const google = makeMirrorCalendar({ deleteAlwaysFails: true });
    const table = makeMirrorRows(1);
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [makeRule()]),
      listSourceEvents: vi.fn(async () => [timedEvent()]),
      loadMirrors: table.loadMirrors,
      saveMirrorRow: table.saveMirrorRow,
      createMirror: google.createMirror,
      deleteMirror: google.deleteMirror,
      listTargetEvents: google.listTargetEvents,
    });

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);
    // 行は書けず補償削除も失敗 = Google 上に孤児が1件残った状態。
    expect(google.events.size).toBe(1);
    expect(table.rows.size).toBe(0);

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);
    // 作り直さずに孤児を回収した: ミラーは1件のまま、行がそれを指している。
    expect(google.createMirror).toHaveBeenCalledTimes(1);
    expect(google.events.size).toBe(1);
    expect(table.rows.get("ev-1")?.mirror_event_id).toBe("mirror-1");

    // 3回目以降も増えない (孤児が毎回積み上がらないことの確認)。
    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);
    expect(google.events.size).toBe(1);
  });

  it("採用した行は source_updated=null で入る (次のリコンサイルで時刻を揃えるため)", async () => {
    const orphan: GoogleEventDTO = timedEvent({
      id: "mirror-orphan",
      extendedProperties: {
        private: {
          [MIRROR_MARKER_KEY]: "1",
          [MIRROR_RULE_KEY]: "rule-1",
          [MIRROR_SOURCE_KEY]: "ev-1",
        },
      },
    });
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [makeRule()]),
      listSourceEvents: vi.fn(async () => [timedEvent({ updated: "2026-07-25T00:00:00.000Z" })]),
      listTargetEvents: vi.fn(async () => [orphan]),
      now: vi.fn(() => 7777),
    });

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

    expect(deps.createMirror).not.toHaveBeenCalled();
    expect(deps.saveMirrorRow).toHaveBeenCalledWith({
      rule_id: "rule-1",
      source_event_id: "ev-1",
      mirror_event_id: "mirror-orphan",
      source_updated: null,
      created_at: 7777,
    });
  });

  it("作るものが無い回は target 一覧を引かない (定常状態で Google 呼び出しを増やさない)", async () => {
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [makeRule()]),
      listSourceEvents: vi.fn(async () => [timedEvent()]),
      loadMirrors: vi.fn(async () => [mirrorRow()]),
    });

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

    expect(deps.listTargetEvents).not.toHaveBeenCalled();
  });

  it("target 一覧の取得に失敗しても、これまで通り新規作成に進む", async () => {
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [makeRule()]),
      listSourceEvents: vi.fn(async () => [timedEvent()]),
      listTargetEvents: vi.fn(async () => {
        throw new Error("google list failed");
      }),
    });

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

    expect(deps.createMirror).toHaveBeenCalledTimes(1);
  });

  it("採用だけで済んだ回は ooo_fallback を上書きしない (Google に body を送っていない)", async () => {
    const orphan: GoogleEventDTO = timedEvent({
      id: "mirror-orphan",
      extendedProperties: {
        private: {
          [MIRROR_MARKER_KEY]: "1",
          [MIRROR_RULE_KEY]: "rule-1",
          [MIRROR_SOURCE_KEY]: "ev-1",
        },
      },
    });
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [makeRule({ mode: "outOfOffice" })]),
      listSourceEvents: vi.fn(async () => [timedEvent()]),
      listTargetEvents: vi.fn(async () => [orphan]),
    });

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

    expect(deps.setRuleOooFallback).not.toHaveBeenCalled();
  });
});

describe("deleteRuleMirrors", () => {
  it("ルールが作った mirror を全件 Google から消す", async () => {
    const mirrors = [
      mirrorRow({ source_event_id: "ev-1", mirror_event_id: "mirror-1" }),
      mirrorRow({ source_event_id: "ev-2", mirror_event_id: "mirror-2" }),
    ];
    const deps = makeDeps();

    const result = await deleteRuleMirrors(
      "rule-1",
      { accountId: "tgt-acc", calendarId: "tgt-cal" },
      mirrors,
      deps,
    );

    expect(deps.deleteMirror).toHaveBeenCalledTimes(2);
    expect(deps.deleteMirror).toHaveBeenNthCalledWith(1, "tgt-acc", "tgt-cal", "mirror-1");
    expect(deps.deleteMirror).toHaveBeenNthCalledWith(2, "tgt-acc", "tgt-cal", "mirror-2");
    expect(result).toEqual({ deleted: 2, failed: 0 });
  });

  it("mirror が1件も無ければ何もしない", async () => {
    const deps = makeDeps();
    const result = await deleteRuleMirrors(
      "rule-1",
      { accountId: "tgt-acc", calendarId: "tgt-cal" },
      [],
      deps,
    );
    expect(deps.deleteMirror).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0, failed: 0 });
  });

  it("1件の削除が失敗しても残りを続ける (best-effort。例外は投げない)", async () => {
    const mirrors = [
      mirrorRow({ source_event_id: "ev-1", mirror_event_id: "mirror-1" }),
      mirrorRow({ source_event_id: "ev-2", mirror_event_id: "mirror-2" }),
      mirrorRow({ source_event_id: "ev-3", mirror_event_id: "mirror-3" }),
    ];
    const deps = makeDeps({
      deleteMirror: vi.fn(async (_a: string, _c: string, mirrorEventId: string) => {
        if (mirrorEventId === "mirror-2") throw new Error("410 Gone (手で消された)");
      }),
    });

    const result = await deleteRuleMirrors(
      "rule-1",
      { accountId: "tgt-acc", calendarId: "tgt-cal" },
      mirrors,
      deps,
    );

    expect(deps.deleteMirror).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ deleted: 2, failed: 1 });
  });

  it("Google の削除が失敗した行は対応表からも消さない (辿れない孤児を作らない)", async () => {
    const deps = makeDeps({
      deleteMirror: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    await deleteRuleMirrors(
      "rule-1",
      { accountId: "tgt-acc", calendarId: "tgt-cal" },
      [mirrorRow()],
      deps,
    );

    expect(deps.deleteMirrorRow).not.toHaveBeenCalled();
  });
});

/**
 * target を変えたルールのリコンサイル。**block_mirrors の行を残したまま target を変えると
 * 404 になる**という回帰 (routes/settings.ts の POST 経路で shouldDiscardMirrorRows が
 * true のとき行を捨てることで直る) を、Google 側を模したフェイクで固定する。
 */
describe("target 変更後のリコンサイル (404 回帰)", () => {
  /** (calendarId, eventId) の対応を持つフェイク Google。知らない組には 404 を投げる。 */
  function makeFakeGoogle(existing: Record<string, string[]>) {
    const calendars: Record<string, Set<string>> = {};
    for (const [calendarId, eventIds] of Object.entries(existing)) {
      calendars[calendarId] = new Set(eventIds);
    }
    let nextId = 0;
    return {
      calendars,
      createMirror: vi.fn(async (_a: string, calendarId: string) => {
        const id = `mirror-new-${++nextId}`;
        (calendars[calendarId] ??= new Set()).add(id);
        return { id, oooFallback: false };
      }),
      patchMirrorTime: vi.fn(async (_a: string, calendarId: string, eventId: string) => {
        if (!calendars[calendarId]?.has(eventId)) {
          throw new Error(`patchEventRaw failed for calendar=${calendarId}: status=404 notFound`);
        }
      }),
      deleteMirror: vi.fn(async (_a: string, calendarId: string, eventId: string) => {
        if (!calendars[calendarId]?.has(eventId)) {
          throw new Error(`deleteEvent failed for calendar=${calendarId}: status=404 notFound`);
        }
        calendars[calendarId].delete(eventId);
      }),
    };
  }

  const RULE_AFTER_TARGET_CHANGE = makeRule({
    target: { accountId: "tgt-acc", calendarId: "tgt-cal-new" },
  });
  /** 古い target (tgt-cal-old) に作られた mirror を指したままの対応表の行。 */
  const STALE_MIRROR = mirrorRow({ source_event_id: "ev-1", mirror_event_id: "mirror-old" });

  it("バグの再現: 古い mirror 行が残っていると新 target への patch が 404 になり、mirror が作られない", async () => {
    const google = makeFakeGoogle({ "tgt-cal-old": ["mirror-old"] });
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [RULE_AFTER_TARGET_CHANGE]),
      // source 側が更新された = toPatch に載る
      listSourceEvents: vi.fn(async () => [timedEvent({ updated: "2026-07-26T00:00:00.000Z" })]),
      loadMirrors: vi.fn(async () => [STALE_MIRROR]),
      createMirror: google.createMirror,
      patchMirrorTime: google.patchMirrorTime,
      deleteMirror: google.deleteMirror,
    });

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

    // 新 target には何も作られないまま、存在しない event への patch が 404 で失敗し続ける。
    expect(google.patchMirrorTime).toHaveBeenCalledWith(
      "tgt-acc",
      "tgt-cal-new",
      "mirror-old",
      expect.anything(),
      expect.anything(),
    );
    expect(google.createMirror).not.toHaveBeenCalled();
    expect(google.calendars["tgt-cal-new"]).toBeUndefined();
    expect(deps.updateMirrorRow).not.toHaveBeenCalled();
  });

  it("修正後: target 変更で行を捨ててあれば、新 target に mirror が作り直され 404 が起きない", async () => {
    const google = makeFakeGoogle({ "tgt-cal-old": ["mirror-old"] });
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [RULE_AFTER_TARGET_CHANGE]),
      listSourceEvents: vi.fn(async () => [timedEvent({ updated: "2026-07-26T00:00:00.000Z" })]),
      // POST /api/block-rules が shouldDiscardMirrorRows=true で行を消した後の状態。
      loadMirrors: vi.fn(async () => []),
      createMirror: google.createMirror,
      patchMirrorTime: google.patchMirrorTime,
      deleteMirror: google.deleteMirror,
    });

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

    expect(google.patchMirrorTime).not.toHaveBeenCalled();
    expect(google.deleteMirror).not.toHaveBeenCalled();
    expect(google.createMirror).toHaveBeenCalledWith(
      "tgt-acc",
      "tgt-cal-new",
      expect.objectContaining({ summary: "予定あり" }),
    );
    expect([...google.calendars["tgt-cal-new"]!]).toEqual(["mirror-new-1"]);
    // 古い target のミラーはそのまま残る (消すのは利用者が明示的に選んだときだけ)。
    expect([...google.calendars["tgt-cal-old"]!]).toEqual(["mirror-old"]);
    expect(deps.saveMirrorRow).toHaveBeenCalledWith(
      expect.objectContaining({ rule_id: "rule-1", mirror_event_id: "mirror-new-1" }),
    );
  });

  it("バグの再現 (削除経路): 古い行が残っていると source 消滅時の delete も新 target に対して 404 になる", async () => {
    const google = makeFakeGoogle({ "tgt-cal-old": ["mirror-old"] });
    const deps = makeDeps({
      loadRulesForSource: vi.fn(async () => [RULE_AFTER_TARGET_CHANGE]),
      // source が消えた = toDelete に載る
      listSourceEvents: vi.fn(async () => []),
      loadMirrors: vi.fn(async () => [STALE_MIRROR]),
      createMirror: google.createMirror,
      patchMirrorTime: google.patchMirrorTime,
      deleteMirror: google.deleteMirror,
    });

    await reconcileSourceChange("src-acc", "src-cal", WINDOW, deps);

    expect(google.deleteMirror).toHaveBeenCalledWith("tgt-acc", "tgt-cal-new", "mirror-old");
    // 404 で失敗するので対応表の行も残り続ける (古い mirror は消えないまま)。
    expect(deps.deleteMirrorRow).not.toHaveBeenCalled();
    expect([...google.calendars["tgt-cal-old"]!]).toEqual(["mirror-old"]);
  });
});
