import { describe, expect, it } from "vite-plus/test";
import {
  buildPlannedBlock,
  computeDropStartMs,
  computeMovedRange,
  computeResizedEndMs,
  DEFAULT_PLANNED_DURATION_MS,
  parseDroppedWorkItem,
  plannedBlockHeightPx,
  plannedBlockTopPx,
  WORKITEM_DND_MIME,
  type DroppedWorkItem,
} from "./planned";
import { SNAP_MS } from "../layout/snap";

const ITEM: DroppedWorkItem = {
  id: "ghq:owner/repo:issue:42",
  type: "issue",
  title: "バグを直す",
  repo: "owner/repo",
  number: 42,
  url: "https://github.com/owner/repo/issues/42",
};

describe("WORKITEM_DND_MIME / DEFAULT_PLANNED_DURATION_MS", () => {
  it("独自 MIME タイプと既定 60分の長さを持つ", () => {
    expect(WORKITEM_DND_MIME).toBe("application/x-kichijitsu-workitem");
    expect(DEFAULT_PLANNED_DURATION_MS).toBe(60 * 60_000);
  });
});

describe("parseDroppedWorkItem", () => {
  it("正しい JSON 文字列から DroppedWorkItem を復元する", () => {
    expect(parseDroppedWorkItem(JSON.stringify(ITEM))).toEqual(ITEM);
  });

  it("null/undefined/空文字は null を返す", () => {
    expect(parseDroppedWorkItem(null)).toBeNull();
    expect(parseDroppedWorkItem(undefined)).toBeNull();
    expect(parseDroppedWorkItem("")).toBeNull();
  });

  it("壊れた JSON は null を返す(例外を投げない)", () => {
    expect(parseDroppedWorkItem("{not json")).toBeNull();
  });

  it("必須フィールドが欠けていれば null を返す", () => {
    expect(parseDroppedWorkItem(JSON.stringify({ id: "x" }))).toBeNull();
    expect(parseDroppedWorkItem(JSON.stringify({ ...ITEM, type: "unknown" }))).toBeNull();
    expect(parseDroppedWorkItem(JSON.stringify({ ...ITEM, number: "42" }))).toBeNull();
  });

  it("PR タイプも受け付ける", () => {
    const pr: DroppedWorkItem = { ...ITEM, type: "pr" };
    expect(parseDroppedWorkItem(JSON.stringify(pr))).toEqual(pr);
  });
});

describe("computeDropStartMs", () => {
  it("日列の 0:00 からの px オフセットを分に変換し 15分スナップする", () => {
    // dayStartMs=0(15分グリッドに揃っている)なら snap は相対オフセットと一致する。
    // HOUR_HEIGHT=48px なので 96px = 2時間 = 7,200,000ms 後 (15分の倍数なのでそのままスナップされる)
    const dayStartMs = 0;
    const startMs = computeDropStartMs(dayStartMs, /* clientY */ 196, /* columnTop */ 100);
    expect(startMs).toBe(dayStartMs + 2 * 60 * 60_000);
  });

  it("15分刻みでない位置は最も近いスナップへ丸める", () => {
    const dayStartMs = 0;
    // 48px/hour → 1px = 1.25分。10px ≒ 12.5分 → 15分刻みなら 15分(900_000ms) に丸まる
    const startMs = computeDropStartMs(dayStartMs, 10, 0);
    expect(startMs % SNAP_MS).toBe(0);
  });
});

describe("buildPlannedBlock", () => {
  it("ドロップされたアイテムと確定した時間帯から PlannedBlock を組み立てる", () => {
    const block = buildPlannedBlock(ITEM, 1_000, 4_600_000, 999);
    expect(block).toEqual({
      id: "plan:ghq:owner/repo:issue:42:999",
      startMs: 1_000,
      endMs: 4_600_000,
      linkedItemId: "ghq:owner/repo:issue:42",
      itemType: "issue",
      title: "バグを直す",
      repo: "owner/repo",
      number: 42,
      url: "https://github.com/owner/repo/issues/42",
    });
  });

  it("nowMs を省略しても一意な id になる(2回呼べば異なる)", () => {
    const a = buildPlannedBlock(ITEM, 0, DEFAULT_PLANNED_DURATION_MS);
    const b = buildPlannedBlock(ITEM, 0, DEFAULT_PLANNED_DURATION_MS, Date.now() + 1);
    expect(a.id).not.toBe(b.id);
  });
});

describe("plannedBlockTopPx / plannedBlockHeightPx", () => {
  it("top は日の 0:00 からの px オフセット", () => {
    const dayStartMs = 1_700_000_000_000;
    expect(plannedBlockTopPx(dayStartMs + 60 * 60_000, dayStartMs)).toBe(48); // 1時間 = 48px
  });

  it("height は最低 4px を保証する", () => {
    expect(plannedBlockHeightPx(0, 0)).toBe(4);
    expect(plannedBlockHeightPx(0, 60 * 60_000)).toBe(48);
  });
});

describe("computeMovedRange", () => {
  it("15分スナップしつつ元の長さを保った新しい開始/終了時刻を返す", () => {
    const originalStartMs = 0;
    const durationMs = 60 * 60_000;
    const { startMs, endMs } = computeMovedRange(7 * 60_000, originalStartMs, durationMs);
    expect(startMs).toBe(0); // 7分は15分スナップで0分側に丸まる
    expect(endMs - startMs).toBe(durationMs);
  });

  it("disableSnap=true のときは1分単位に丸める", () => {
    const { startMs } = computeMovedRange(7 * 60_000, 0, 60 * 60_000, true);
    expect(startMs).toBe(7 * 60_000);
  });
});

describe("computeResizedEndMs", () => {
  it("15分スナップしつつ最低 SNAP_MS の長さを保証する", () => {
    const startMs = 0;
    const endMs = computeResizedEndMs(5 * 60_000, startMs, startMs);
    expect(endMs).toBe(SNAP_MS); // 最低15分を下回らない
  });

  it("十分な長さがあればそのままスナップする", () => {
    const startMs = 0;
    const endMs = computeResizedEndMs(37 * 60_000, startMs, startMs);
    expect(endMs).toBe(30 * 60_000); // 37分は30分側にスナップ
  });
});
