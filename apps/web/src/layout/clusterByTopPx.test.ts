import { describe, expect, it } from "vite-plus/test";
import { clusterByTopPx, clusterOverflowSuffix } from "./clusterByTopPx";
import { DEFAULT_HOUR_HEIGHT, MAX_HOUR_HEIGHT, pxPerMinute } from "./gridMetrics";

/**
 * 近接タイムスタンプのクラスタリング generic 本体のテスト(2026-07-26 に sync/mapActivity.ts と
 * sync/mapCiRuns.ts の同一実装2本をここへ統合した)。DTO ごとの薄いラッパー越しの挙動は
 * 従来どおり mapActivity.test.ts / mapCiRuns.test.ts が固定しているので、ここでは
 * 「timestampMs しか見ない」ことが分かる最小の型で本体だけを見る。
 */

interface Marker {
  id: string;
  timestampMs: number;
}

const dayStart = Date.UTC(2026, 6, 20);
const dayEnd = Date.UTC(2026, 6, 21);

function at(id: string, offsetMinutes: number): Marker {
  return { id, timestampMs: dayStart + offsetMinutes * 60_000 };
}

describe("clusterByTopPx", () => {
  it("空配列を渡せば空配列を返す", () => {
    expect(clusterByTopPx([], dayStart, dayEnd, DEFAULT_HOUR_HEIGHT)).toEqual([]);
  });

  it("範囲内の1件だけなら1クラスタ、count:1、topPx は分オフセット × px/分", () => {
    const item = at("a", 90);
    const clusters = clusterByTopPx([item], dayStart, dayEnd, DEFAULT_HOUR_HEIGHT);
    expect(clusters).toEqual([
      { topPx: 90 * pxPerMinute(DEFAULT_HOUR_HEIGHT), items: [item], count: 1 },
    ]);
  });

  it("半開区間: dayStartMs ちょうどは含み、dayEndMs ちょうどは除外する", () => {
    expect(
      clusterByTopPx(
        [{ id: "start", timestampMs: dayStart }],
        dayStart,
        dayEnd,
        DEFAULT_HOUR_HEIGHT,
      ),
    ).toHaveLength(1);
    expect(
      clusterByTopPx([{ id: "end", timestampMs: dayEnd }], dayStart, dayEnd, DEFAULT_HOUR_HEIGHT),
    ).toEqual([]);
  });

  it("範囲外(前日・翌日)のアイテムは除外する", () => {
    const before = { id: "before", timestampMs: dayStart - 1 };
    const after = { id: "after", timestampMs: dayEnd + 1 };
    expect(clusterByTopPx([before, after], dayStart, dayEnd, DEFAULT_HOUR_HEIGHT)).toEqual([]);
  });

  it("topPx の差が6pxを超える2件は別クラスタ、6px以内なら1クラスタ(既定ズームで 6px ≈ 7.5分)", () => {
    const far = clusterByTopPx([at("a", 60), at("b", 75)], dayStart, dayEnd, DEFAULT_HOUR_HEIGHT);
    expect(far.map((c) => c.count)).toEqual([1, 1]);

    const near = clusterByTopPx([at("a", 60), at("b", 65)], dayStart, dayEnd, DEFAULT_HOUR_HEIGHT);
    expect(near.map((c) => c.count)).toEqual([2]);
  });

  it("入力順に関わらず items は timestampMs 昇順、クラスタ順も topPx 昇順になる", () => {
    const later = at("later", 65);
    const earlier = at("earlier", 60);
    const clusters = clusterByTopPx([later, earlier], dayStart, dayEnd, DEFAULT_HOUR_HEIGHT);
    expect(clusters[0].items).toEqual([earlier, later]);

    const spread = clusterByTopPx(
      [at("late", 20 * 60), at("early", 10)],
      dayStart,
      dayEnd,
      DEFAULT_HOUR_HEIGHT,
    );
    expect(spread.map((c) => c.items[0].id)).toEqual(["early", "late"]);
    expect(spread[0].topPx).toBeLessThan(spread[1].topPx);
  });

  it("アンカー基準なので連鎖しない(A-B・B-C が6px以内でも A-C が超えるなら C は別クラスタ)", () => {
    // A=0分, B=+5分(4px), C=+10分(8px = A から 6px 超, B からは 4px)
    const clusters = clusterByTopPx(
      [at("a", 0), at("b", 5), at("c", 10)],
      dayStart,
      dayEnd,
      DEFAULT_HOUR_HEIGHT,
    );
    expect(clusters.map((c) => c.items.map((i) => i.id))).toEqual([["a", "b"], ["c"]]);
  });

  it("ズームを拡大すると同じ時間差でもクラスタが分かれる(しきい値が px 基準であること)", () => {
    // 5分差 = 既定 48px/h なら 4px(まとまる)、上限の 120px/h なら 10px(分かれる)
    const items = [at("a", 60), at("b", 65)];
    expect(clusterByTopPx(items, dayStart, dayEnd, DEFAULT_HOUR_HEIGHT)).toHaveLength(1);
    expect(clusterByTopPx(items, dayStart, dayEnd, MAX_HOUR_HEIGHT)).toHaveLength(2);
  });

  it("入力配列を破壊的に変更しない", () => {
    const items = [at("x", 20), at("y", 5)];
    const snapshot = [...items];
    clusterByTopPx(items, dayStart, dayEnd, DEFAULT_HOUR_HEIGHT);
    expect(items).toEqual(snapshot);
  });
});

describe("clusterOverflowSuffix", () => {
  it("1件なら空文字(ラベルに何も足さない)", () => {
    expect(clusterOverflowSuffix(1)).toBe("");
  });

  it("0件でも空文字(理論上起きないが分岐を固定しておく)", () => {
    expect(clusterOverflowSuffix(0)).toBe("");
  });

  it("2件以上なら代表1件を除いた残り件数を「 他N件」で表す", () => {
    expect(clusterOverflowSuffix(2)).toBe(" 他1件");
    expect(clusterOverflowSuffix(5)).toBe(" 他4件");
  });
});
