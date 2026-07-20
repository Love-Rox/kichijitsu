import { describe, expect, it } from "vite-plus/test";
import type { GitHubCiRunDTO } from "@kichijitsu/shared";
import { PX_PER_MINUTE } from "../layout/gridMetrics";
import { ciMarkerStatusClass, ciStatusLabel, layoutDayCiRuns } from "./mapCiRuns";

function run(overrides: Partial<GitHubCiRunDTO> = {}): GitHubCiRunDTO {
  return {
    id: "gci:acme/repo:1",
    repo: "acme/repo",
    name: "CI",
    url: "https://github.com/acme/repo/actions/runs/1",
    status: "completed",
    conclusion: "success",
    timestampMs: Date.UTC(2026, 6, 20, 10, 0, 0),
    ...overrides,
  };
}

describe("layoutDayCiRuns", () => {
  const dayStart = Date.UTC(2026, 6, 20);
  const dayEnd = Date.UTC(2026, 6, 21);

  it("空配列を渡せば空配列を返す", () => {
    expect(layoutDayCiRuns([], dayStart, dayEnd)).toEqual([]);
  });

  it("範囲内の1件だけなら1クラスタ、count:1、topPx は正しい位置", () => {
    const item = run({ timestampMs: dayStart + 90 * 60_000 });
    const clusters = layoutDayCiRuns([item], dayStart, dayEnd);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(1);
    expect(clusters[0].items).toEqual([item]);
    expect(clusters[0].topPx).toBe(90 * PX_PER_MINUTE);
  });

  it("dayStartMs ちょうどのアイテムは含む(半開区間の下端)", () => {
    const item = run({ timestampMs: dayStart });
    const clusters = layoutDayCiRuns([item], dayStart, dayEnd);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].topPx).toBe(0);
  });

  it("dayEndMs ちょうどのアイテムは除外する(半開区間の上端)", () => {
    const item = run({ timestampMs: dayEnd });
    expect(layoutDayCiRuns([item], dayStart, dayEnd)).toEqual([]);
  });

  it("dayStartMs より前・dayEndMs より後のアイテムは除外する", () => {
    const before = run({ id: "gci:acme/repo:before", timestampMs: dayStart - 1 });
    const after = run({ id: "gci:acme/repo:after", timestampMs: dayEnd + 1 });
    expect(layoutDayCiRuns([before, after], dayStart, dayEnd)).toEqual([]);
  });

  it("topPx の差が6pxを超える2件は別クラスタになる", () => {
    const a = run({ id: "gci:acme/repo:a", timestampMs: dayStart + 60 * 60_000 });
    const b = run({ id: "gci:acme/repo:b", timestampMs: dayStart + 75 * 60_000 });
    const clusters = layoutDayCiRuns([a, b], dayStart, dayEnd);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].count).toBe(1);
    expect(clusters[1].count).toBe(1);
  });

  it("topPx の差が6px以内の2件は1クラスタにまとまり、items は入力順に関わらず timestampMs 昇順", () => {
    const later = run({
      id: "gci:acme/repo:later",
      timestampMs: dayStart + 60 * 60_000 + 5 * 60_000,
    });
    const earlier = run({ id: "gci:acme/repo:earlier", timestampMs: dayStart + 60 * 60_000 });
    const clusters = layoutDayCiRuns([later, earlier], dayStart, dayEnd);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(2);
    expect(clusters[0].items).toEqual([earlier, later]);
  });

  it("A-B・B-Cはそれぞれ6px以内でもA-Cが6pxを超えるならCはAのクラスタに入らない(アンカー基準、連鎖しない)", () => {
    const a = run({ id: "gci:acme/repo:a", timestampMs: dayStart });
    const b = run({ id: "gci:acme/repo:b", timestampMs: dayStart + 5 * 60_000 });
    const c = run({ id: "gci:acme/repo:c", timestampMs: dayStart + 10 * 60_000 });
    const clusters = layoutDayCiRuns([a, b, c], dayStart, dayEnd);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].items.map((i) => i.id)).toEqual([a.id, b.id]);
    expect(clusters[1].items.map((i) => i.id)).toEqual([c.id]);
  });

  it("入力が未ソートでも、出力のクラスタ順は timestampMs/topPx 昇順になる", () => {
    const early = run({ id: "gci:acme/repo:early", timestampMs: dayStart + 10 * 60_000 });
    const late = run({ id: "gci:acme/repo:late", timestampMs: dayStart + 20 * 60 * 60_000 });
    const clusters = layoutDayCiRuns([late, early], dayStart, dayEnd);
    expect(clusters.map((c) => c.items[0].id)).toEqual([early.id, late.id]);
    expect(clusters[0].topPx).toBeLessThan(clusters[1].topPx);
  });

  it("入力配列を破壊的に変更しない", () => {
    const items = [
      run({ id: "gci:acme/repo:x", timestampMs: dayStart + 20 * 60_000 }),
      run({ id: "gci:acme/repo:y", timestampMs: dayStart + 5 * 60_000 }),
    ];
    const snapshot = [...items];
    layoutDayCiRuns(items, dayStart, dayEnd);
    expect(items).toEqual(snapshot);
  });
});

describe("ciMarkerStatusClass", () => {
  it("status !== 'completed' は pending (queued)", () => {
    expect(ciMarkerStatusClass(run({ status: "queued", conclusion: null }))).toBe("pending");
  });

  it("status !== 'completed' は pending (in_progress)", () => {
    expect(ciMarkerStatusClass(run({ status: "in_progress", conclusion: null }))).toBe("pending");
  });

  it("completed + success は success", () => {
    expect(ciMarkerStatusClass(run({ status: "completed", conclusion: "success" }))).toBe(
      "success",
    );
  });

  it("completed + failure は failure", () => {
    expect(ciMarkerStatusClass(run({ status: "completed", conclusion: "failure" }))).toBe(
      "failure",
    );
  });

  it("completed + それ以外の conclusion (cancelled等) は other", () => {
    expect(ciMarkerStatusClass(run({ status: "completed", conclusion: "cancelled" }))).toBe(
      "other",
    );
  });

  it("completed + null conclusion は other", () => {
    expect(ciMarkerStatusClass(run({ status: "completed", conclusion: null }))).toBe("other");
  });
});

describe("ciStatusLabel", () => {
  it("未完了は status をそのまま返す", () => {
    expect(ciStatusLabel(run({ status: "in_progress", conclusion: null }))).toBe("in_progress");
  });

  it("完了済みは conclusion を返す", () => {
    expect(ciStatusLabel(run({ status: "completed", conclusion: "failure" }))).toBe("failure");
  });

  it("完了済みで conclusion が null なら status にフォールバックする", () => {
    expect(ciStatusLabel(run({ status: "completed", conclusion: null }))).toBe("completed");
  });
});
