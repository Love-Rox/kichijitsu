import { describe, expect, it } from "vite-plus/test";
import {
  aggregatePlannedVsActual,
  entryDurationMs,
  formatDurationHm,
  startTimer,
  stopTimer,
  type TimerLinkedItem,
} from "./timeTracking";
import type { PlannedBlock, TimeEntry } from "../model/types";

const ITEM: TimerLinkedItem = {
  linkedItemId: "ghq:owner/repo:issue:42",
  itemType: "issue",
  title: "バグを直す",
  repo: "owner/repo",
  number: 42,
  url: "https://github.com/owner/repo/issues/42",
};

function planned(linkedItemId: string, startMs: number, endMs: number): PlannedBlock {
  return {
    id: `plan:${linkedItemId}:${startMs}`,
    startMs,
    endMs,
    linkedItemId,
    itemType: "issue",
    title: "予定タイトル",
    repo: "owner/repo",
    number: 1,
    url: "https://github.com/owner/repo/issues/1",
  };
}

function entry(
  linkedItemId: string,
  startMs: number,
  endMs: number | null,
  overrides: Partial<TimeEntry> = {},
): TimeEntry {
  return {
    id: `te:${linkedItemId}:${startMs}`,
    linkedItemId,
    itemType: "issue",
    title: "実績タイトル",
    repo: "owner/repo",
    number: 1,
    url: "https://github.com/owner/repo/issues/1",
    startMs,
    endMs,
    ...overrides,
  };
}

describe("startTimer", () => {
  it("endMs=null の走行中エントリを組み立てる", () => {
    const e = startTimer(ITEM, 1_000);
    expect(e).toEqual({
      id: "te:ghq:owner/repo:issue:42:1000",
      linkedItemId: "ghq:owner/repo:issue:42",
      itemType: "issue",
      title: "バグを直す",
      repo: "owner/repo",
      number: 42,
      url: "https://github.com/owner/repo/issues/42",
      startMs: 1_000,
      endMs: null,
    });
  });

  it("nowMs を省略しても Date.now() 由来で一意になる", () => {
    const a = startTimer(ITEM);
    const b = startTimer(ITEM, Date.now() + 1);
    expect(a.id).not.toBe(b.id);
  });
});

describe("stopTimer", () => {
  it("走行中エントリの endMs を nowMs で埋める", () => {
    const e = entry("x", 0, null);
    const stopped = stopTimer(e, 5 * 60_000);
    expect(stopped.endMs).toBe(5 * 60_000);
  });

  it("最低1分(MIN_DURATION_MS)を下回らない", () => {
    const e = entry("x", 0, null);
    const stopped = stopTimer(e, 10_000); // 10秒後に止めても1分に切り上げ
    expect(stopped.endMs).toBe(60_000);
  });

  it("既に確定済み(endMs!==null)のエントリはそのまま返す(冪等)", () => {
    const e = entry("x", 0, 10_000);
    const stopped = stopTimer(e, 999_999);
    expect(stopped).toEqual(e);
  });
});

describe("entryDurationMs", () => {
  it("走行中は nowMs までの経過を返す", () => {
    const e = entry("x", 1_000, null);
    expect(entryDurationMs(e, 61_000)).toBe(60_000);
  });

  it("確定済みは endMs-startMs をそのまま返す(nowMs は無視)", () => {
    const e = entry("x", 1_000, 121_000);
    expect(entryDurationMs(e, 999_999_999)).toBe(120_000);
  });
});

describe("formatDurationHm", () => {
  it("1時間未満は分のみ", () => {
    expect(formatDurationHm(45 * 60_000)).toBe("45m");
  });

  it("1時間以上は時+分", () => {
    expect(formatDurationHm(2 * 60 * 60_000 + 15 * 60_000)).toBe("2h 15m");
  });

  it("0ms は 0m", () => {
    expect(formatDurationHm(0)).toBe("0m");
  });
});

describe("aggregatePlannedVsActual", () => {
  it("linkedItemId でグルーピングし予定/実績を合算する", () => {
    const blocks = [planned("a", 0, 60 * 60_000), planned("a", 2 * 60 * 60_000, 3 * 60 * 60_000)];
    const entries = [entry("a", 0, 30 * 60_000)];
    const rows = aggregatePlannedVsActual(blocks, entries, 0);

    expect(rows).toHaveLength(1);
    expect(rows[0].linkedItemId).toBe("a");
    expect(rows[0].plannedMs).toBe(2 * 60 * 60_000); // 60分+60分
    expect(rows[0].actualMs).toBe(30 * 60_000);
  });

  it("予定だけ/実績だけの item も行として含める", () => {
    const blocks = [planned("planned-only", 0, 60 * 60_000)];
    const entries = [entry("actual-only", 0, 30 * 60_000)];
    const rows = aggregatePlannedVsActual(blocks, entries, 0);

    expect(rows.map((r) => r.linkedItemId).sort()).toEqual(["actual-only", "planned-only"]);
    const plannedOnly = rows.find((r) => r.linkedItemId === "planned-only");
    expect(plannedOnly?.plannedMs).toBe(60 * 60_000);
    expect(plannedOnly?.actualMs).toBe(0);
    const actualOnly = rows.find((r) => r.linkedItemId === "actual-only");
    expect(actualOnly?.plannedMs).toBe(0);
    expect(actualOnly?.actualMs).toBe(30 * 60_000);
  });

  it("走行中(endMs=null)のエントリは nowMs までの経過を actualMs に含める", () => {
    const entries = [entry("running", 0, null)];
    const rows = aggregatePlannedVsActual([], entries, 90_000);
    expect(rows[0].actualMs).toBe(90_000);
  });

  it("実績降順 → 予定降順 → タイトル昇順で安定にソートする", () => {
    const blocks = [
      planned("low-both", 0, 0),
      { ...planned("high-planned", 0, 100), title: "Bタイトル" },
    ];
    const entries = [entry("high-actual", 0, 1_000, { title: "Aタイトル" })];
    const rows = aggregatePlannedVsActual(blocks, entries, 1_000);
    expect(rows.map((r) => r.linkedItemId)).toEqual(["high-actual", "high-planned", "low-both"]);
  });

  it("空入力なら空配列", () => {
    expect(aggregatePlannedVsActual([], [], 0)).toEqual([]);
  });
});
