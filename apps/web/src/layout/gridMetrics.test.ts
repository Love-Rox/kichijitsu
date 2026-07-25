import { describe, expect, it } from "vite-plus/test";
import {
  busyOverlapColors,
  clampHourHeight,
  DAY_COLUMN_INSET_PX,
  dayColumnLeftInsetPx,
  dayHeightPx,
  DEFAULT_HOUR_HEIGHT,
  HOUR_HEIGHT_PRESETS,
  locationLineClamp,
  matchHourHeightPreset,
  MAX_HOUR_HEIGHT,
  MIN_HOUR_HEIGHT,
  minutesToPx,
  normalizeHourHeight,
  overlapsBusy,
  pxToMinutes,
  RAIL_BAND_WIDTH_PX,
  zoomedScrollTop,
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
  it("その日のレール列数が0(不在レール・勤務場所レールがどちらも無い)なら従来の DAY_COLUMN_INSET_PX のまま", () => {
    expect(dayColumnLeftInsetPx(0)).toBe(DAY_COLUMN_INSET_PX);
  });

  it("列数1(重なりが無い日、OOO/勤務場所のどちらか・両方でも時間が重ならなければ1列)は帯幅(12px)+隙間(4px)ぶん広げた16pxを返す", () => {
    expect(dayColumnLeftInsetPx(1)).toBe(RAIL_BAND_WIDTH_PX + 4);
  });

  it("列数2(時間が重なる日)は帯幅の2列ぶん(24px)+隙間(4px)=28pxを返す", () => {
    expect(dayColumnLeftInsetPx(2)).toBe(RAIL_BAND_WIDTH_PX * 2 + 4);
  });
});

// ---- 時間軸ズーム (2026-07-25) ----

describe("minutesToPx / pxToMinutes", () => {
  it("既定ズーム(48px/h)では従来どおり 1分 = 0.8px", () => {
    expect(minutesToPx(60, DEFAULT_HOUR_HEIGHT)).toBe(48);
    expect(minutesToPx(30, DEFAULT_HOUR_HEIGHT)).toBe(24);
    expect(pxToMinutes(48, DEFAULT_HOUR_HEIGHT)).toBe(60);
  });

  it("hourHeight に比例する", () => {
    expect(minutesToPx(60, 24)).toBe(24);
    expect(minutesToPx(60, 120)).toBe(120);
    expect(pxToMinutes(120, 120)).toBe(60);
  });

  it("往復しても値が保たれる(ドラッグの px→分→px 変換が壊れない)", () => {
    for (const hourHeight of [24, 32, 48, 72, 120]) {
      expect(minutesToPx(pxToMinutes(123, hourHeight), hourHeight)).toBeCloseTo(123, 10);
    }
  });

  it("dayHeightPx は24時間ぶん(CSS の calc(var(--hour-height) * 24) と一致)", () => {
    expect(dayHeightPx(DEFAULT_HOUR_HEIGHT)).toBe(1152);
    expect(dayHeightPx(24)).toBe(576);
  });
});

describe("clampHourHeight", () => {
  it("範囲内はそのまま(整数に丸める)", () => {
    expect(clampHourHeight(56)).toBe(56);
    expect(clampHourHeight(56.4)).toBe(56);
  });

  it("範囲外は下限/上限へ丸める", () => {
    expect(clampHourHeight(0)).toBe(MIN_HOUR_HEIGHT);
    expect(clampHourHeight(-100)).toBe(MIN_HOUR_HEIGHT);
    expect(clampHourHeight(1000)).toBe(MAX_HOUR_HEIGHT);
  });
});

describe("normalizeHourHeight", () => {
  it("数値文字列(localStorage の保存値)を受け付ける", () => {
    expect(normalizeHourHeight("56")).toBe(56);
    expect(normalizeHourHeight(72)).toBe(72);
  });

  it("不正値・範囲外は既定(48)へ丸める", () => {
    expect(normalizeHourHeight(null)).toBe(DEFAULT_HOUR_HEIGHT);
    expect(normalizeHourHeight("")).toBe(DEFAULT_HOUR_HEIGHT);
    expect(normalizeHourHeight("compact")).toBe(DEFAULT_HOUR_HEIGHT);
    expect(normalizeHourHeight(Number.NaN)).toBe(DEFAULT_HOUR_HEIGHT);
    expect(normalizeHourHeight(Number.POSITIVE_INFINITY)).toBe(DEFAULT_HOUR_HEIGHT);
    expect(normalizeHourHeight(MIN_HOUR_HEIGHT - 1)).toBe(DEFAULT_HOUR_HEIGHT);
    expect(normalizeHourHeight(MAX_HOUR_HEIGHT + 1)).toBe(DEFAULT_HOUR_HEIGHT);
  });

  it("下限/上限そのものは有効値", () => {
    expect(normalizeHourHeight(MIN_HOUR_HEIGHT)).toBe(MIN_HOUR_HEIGHT);
    expect(normalizeHourHeight(MAX_HOUR_HEIGHT)).toBe(MAX_HOUR_HEIGHT);
  });
});

describe("matchHourHeightPreset", () => {
  it("プリセットと一致すればその id、外れていれば null", () => {
    expect(matchHourHeightPreset(32)).toBe("compact");
    expect(matchHourHeightPreset(DEFAULT_HOUR_HEIGHT)).toBe("normal");
    expect(matchHourHeightPreset(72)).toBe("relaxed");
    expect(matchHourHeightPreset(56)).toBeNull();
  });

  it("すべてのプリセットが有効な範囲内にある", () => {
    for (const preset of HOUR_HEIGHT_PRESETS) {
      expect(clampHourHeight(preset.px)).toBe(preset.px);
      expect(matchHourHeightPreset(preset.px)).toBe(preset.id);
    }
  });
});

describe("zoomedScrollTop", () => {
  it("アンカー位置に見えている時刻がズーム後も同じ位置に来る", () => {
    // 48px/h で 8:00 が画面上端 → scrollTop = 384。アンカーを 100px の位置に取る
    // (= 8:00 + 125分 = 10:05)。96px/h にすると同じ時刻は 2 倍の位置に来るので、
    // scrollTop は (384 + 100) * 2 - 100 = 868。
    expect(zoomedScrollTop(384, 100, 48, 96)).toBe(868);
  });

  it("ズーム前後が同じなら scrollTop は変わらない", () => {
    expect(zoomedScrollTop(384, 100, 48, 48)).toBe(384);
  });

  it("先頭付近で縮小しても負にならない", () => {
    expect(zoomedScrollTop(0, 200, 120, 24)).toBe(0);
  });
});

describe("locationLineClamp", () => {
  it("既定ズーム(48px/h)の1時間の予定は従来どおり1行", () => {
    expect(locationLineClamp(minutesToPx(60, DEFAULT_HOUR_HEIGHT))).toBe(1);
  });

  it("カードが高くなるほど行数が増える(ズーム/長い予定で読める行数が増える)", () => {
    // 1行 = 12px * 1.3 = 15.6px、上下 padding 4px、時刻ヘッダー+タイトルで2行ぶん消費
    expect(locationLineClamp(72)).toBe(2);
    expect(locationLineClamp(minutesToPx(60, 120))).toBe(5);
    expect(locationLineClamp(minutesToPx(120, 120))).toBe(13);
  });

  it("高さが足りなくても最低1行は返す(場所が完全に消えないようにする)", () => {
    expect(locationLineClamp(0)).toBe(1);
    expect(locationLineClamp(20)).toBe(1);
  });

  it("行数は単調非減少", () => {
    let prev = 0;
    for (let h = 0; h <= 400; h += 4) {
      const lines = locationLineClamp(h);
      expect(lines).toBeGreaterThanOrEqual(prev);
      prev = lines;
    }
  });
});
