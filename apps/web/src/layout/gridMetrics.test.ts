import { describe, expect, it } from "vite-plus/test";
import {
  busyOverlapColors,
  DAY_COLUMN_INSET_PX,
  dayColumnLeftInsetPx,
  overlapsBusy,
  type TimeInterval,
} from "./gridMetrics";

function occ(startMs: number, endMs: number) {
  return { startMs, endMs };
}

describe("overlapsBusy", () => {
  it("busy 区間と部分的に重なれば true", () => {
    const busy: TimeInterval[] = [{ startMs: 100, endMs: 200 }];
    expect(overlapsBusy(occ(150, 250), busy)).toBe(true);
    expect(overlapsBusy(occ(50, 150), busy)).toBe(true);
  });

  it("busy 区間を完全に内包/内包されていれば true", () => {
    const busy: TimeInterval[] = [{ startMs: 100, endMs: 200 }];
    expect(overlapsBusy(occ(0, 300), busy)).toBe(true);
    expect(overlapsBusy(occ(120, 180), busy)).toBe(true);
  });

  it("端が接するだけ(重なりなし)は false", () => {
    const busy: TimeInterval[] = [{ startMs: 100, endMs: 200 }];
    expect(overlapsBusy(occ(0, 100), busy)).toBe(false);
    expect(overlapsBusy(occ(200, 300), busy)).toBe(false);
  });

  it("busy 区間と完全に離れていれば false", () => {
    const busy: TimeInterval[] = [{ startMs: 100, endMs: 200 }];
    expect(overlapsBusy(occ(300, 400), busy)).toBe(false);
    expect(overlapsBusy(occ(0, 50), busy)).toBe(false);
  });

  it("busy 区間が複数あるとき、どれか1つとでも重なれば true", () => {
    const busy: TimeInterval[] = [
      { startMs: 0, endMs: 50 },
      { startMs: 300, endMs: 400 },
    ];
    expect(overlapsBusy(occ(350, 360), busy)).toBe(true);
  });

  it("busy 区間が空なら常に false", () => {
    expect(overlapsBusy(occ(0, 100), [])).toBe(false);
  });
});

describe("busyOverlapColors", () => {
  const bi = (s: number, e: number, color: string) => ({ startMs: s, endMs: e, color });
  it("重なる Busy の色を重複排除して返す", () => {
    const busy = [bi(100, 200, "#16a765"), bi(150, 300, "#16a765"), bi(400, 500, "#4986e7")];
    expect(busyOverlapColors({ startMs: 120, endMs: 160 }, busy)).toEqual(["#16a765"]);
    expect(busyOverlapColors({ startMs: 120, endMs: 450 }, busy)).toEqual(["#16a765", "#4986e7"]);
  });
  it("重なりが無ければ空", () => {
    expect(busyOverlapColors({ startMs: 0, endMs: 100 }, [bi(100, 200, "#000")])).toEqual([]);
  });
  it("max で上限を切る", () => {
    const busy = [bi(0, 10, "#a"), bi(0, 10, "#b"), bi(0, 10, "#c"), bi(0, 10, "#d")];
    expect(busyOverlapColors({ startMs: 0, endMs: 10 }, busy, 2)).toEqual(["#a", "#b"]);
  });
});

describe("dayColumnLeftInsetPx", () => {
  it("不在レールが無い日は従来の DAY_COLUMN_INSET_PX のまま", () => {
    expect(dayColumnLeftInsetPx(false)).toBe(DAY_COLUMN_INSET_PX);
  });

  it("不在レールがある日は矩形バー幅(12px)+隙間(4px)ぶん広げた16pxを返す", () => {
    expect(dayColumnLeftInsetPx(true)).toBe(16);
  });
});
