import { describe, expect, it } from "vite-plus/test";
import type { GitHubActivityDTO } from "@kichijitsu/shared";
import { PX_PER_MINUTE } from "../layout/gridMetrics";
import { layoutDayActivity } from "./mapActivity";

function activity(overrides: Partial<GitHubActivityDTO> = {}): GitHubActivityDTO {
  return {
    id: "gha:acme/repo:commit:abc123",
    type: "commit",
    title: "Fix bug",
    repo: "acme/repo",
    url: "https://github.com/acme/repo/commit/abc123",
    timestampMs: Date.UTC(2026, 6, 20, 10, 0, 0),
    ...overrides,
  };
}

describe("layoutDayActivity", () => {
  const dayStart = Date.UTC(2026, 6, 20);
  const dayEnd = Date.UTC(2026, 6, 21);

  it("空配列を渡せば空配列を返す", () => {
    expect(layoutDayActivity([], dayStart, dayEnd)).toEqual([]);
  });

  it("範囲内の1件だけなら1クラスタ、count:1、topPx は正しい位置", () => {
    const item = activity({ timestampMs: dayStart + 90 * 60_000 }); // dayStart + 90分
    const clusters = layoutDayActivity([item], dayStart, dayEnd);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(1);
    expect(clusters[0].items).toEqual([item]);
    expect(clusters[0].topPx).toBe(90 * PX_PER_MINUTE);
  });

  it("dayStartMs ちょうどのアイテムは含む(半開区間の下端)", () => {
    const item = activity({ timestampMs: dayStart });
    const clusters = layoutDayActivity([item], dayStart, dayEnd);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].topPx).toBe(0);
  });

  it("dayEndMs ちょうどのアイテムは除外する(半開区間の上端)", () => {
    const item = activity({ timestampMs: dayEnd });
    expect(layoutDayActivity([item], dayStart, dayEnd)).toEqual([]);
  });

  it("dayStartMs より前・dayEndMs より後のアイテムは除外する", () => {
    const before = activity({ id: "gha:acme/repo:commit:before", timestampMs: dayStart - 1 });
    const after = activity({ id: "gha:acme/repo:commit:after", timestampMs: dayEnd + 1 });
    expect(layoutDayActivity([before, after], dayStart, dayEnd)).toEqual([]);
  });

  it("topPx の差が6pxを超える2件は別クラスタになる", () => {
    // 6px ≈ 7.5分(PX_PER_MINUTE=0.8)。余裕を持って15分離す
    const a = activity({ id: "gha:acme/repo:commit:a", timestampMs: dayStart + 60 * 60_000 });
    const b = activity({
      id: "gha:acme/repo:commit:b",
      timestampMs: dayStart + 75 * 60_000,
    });
    const clusters = layoutDayActivity([a, b], dayStart, dayEnd);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].count).toBe(1);
    expect(clusters[1].count).toBe(1);
  });

  it("topPx の差が6px以内の2件は1クラスタにまとまり、items は入力順に関わらず timestampMs 昇順", () => {
    // 6px = 7.5分。5分差(=4px)なら確実にしきい値以内
    const later = activity({
      id: "gha:acme/repo:commit:later",
      timestampMs: dayStart + 60 * 60_000 + 5 * 60_000,
    });
    const earlier = activity({
      id: "gha:acme/repo:commit:earlier",
      timestampMs: dayStart + 60 * 60_000,
    });
    // 入力は「後 → 先」の逆順で渡す
    const clusters = layoutDayActivity([later, earlier], dayStart, dayEnd);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(2);
    expect(clusters[0].items).toEqual([earlier, later]);
  });

  it("A-B・B-Cはそれぞれ6px以内でもA-Cが6pxを超えるならCはAのクラスタに入らない(アンカー基準、連鎖しない)", () => {
    // このテストが無いと「直前アイテムとの距離」で連結する誤実装(chaining)を通してしまう。
    // A=0分, B=+5分(=4px, Aから6px以内), C=+10分(=8px, Aから6pxを超えるが直前のBからは4px)
    // アンカー基準の正しい実装では A,B が1クラスタ、C は新規クラスタになるはず
    const a = activity({ id: "gha:acme/repo:commit:a", timestampMs: dayStart });
    const b = activity({
      id: "gha:acme/repo:commit:b",
      timestampMs: dayStart + 5 * 60_000,
    });
    const c = activity({
      id: "gha:acme/repo:commit:c",
      timestampMs: dayStart + 10 * 60_000,
    });
    const clusters = layoutDayActivity([a, b, c], dayStart, dayEnd);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].items.map((i) => i.id)).toEqual([a.id, b.id]);
    expect(clusters[1].items.map((i) => i.id)).toEqual([c.id]);
  });

  it("入力が未ソートでも、出力のクラスタ順は timestampMs/topPx 昇順になる", () => {
    const early = activity({
      id: "gha:acme/repo:commit:early",
      timestampMs: dayStart + 10 * 60_000,
    });
    const late = activity({
      id: "gha:acme/repo:commit:late",
      timestampMs: dayStart + 20 * 60 * 60_000,
    });
    const clusters = layoutDayActivity([late, early], dayStart, dayEnd);
    expect(clusters.map((c) => c.items[0].id)).toEqual([early.id, late.id]);
    expect(clusters[0].topPx).toBeLessThan(clusters[1].topPx);
  });

  it("入力配列を破壊的に変更しない", () => {
    const items = [
      activity({ id: "gha:acme/repo:commit:x", timestampMs: dayStart + 20 * 60_000 }),
      activity({ id: "gha:acme/repo:commit:y", timestampMs: dayStart + 5 * 60_000 }),
    ];
    const snapshot = [...items];
    layoutDayActivity(items, dayStart, dayEnd);
    expect(items).toEqual(snapshot);
  });
});
