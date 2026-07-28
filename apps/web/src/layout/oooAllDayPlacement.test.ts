import { describe, expect, it } from "vite-plus/test";
import type { StorageLike } from "./localStore";
import {
  DEFAULT_OOO_ALLDAY_PLACEMENT,
  getOooAllDayPlacement,
  normalizeOooAllDayPlacement,
  setOooAllDayPlacement,
} from "./oooAllDayPlacement";

/** localStore.test.ts と同じ流儀のフェイク(このテスト環境には window が無い) */
function fakeStorage(
  initial: Record<string, string> = {},
): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("normalizeOooAllDayPlacement", () => {
  it("2択の値はそのまま通る", () => {
    expect(normalizeOooAllDayPlacement("timeline")).toBe("timeline");
    expect(normalizeOooAllDayPlacement("allday")).toBe("allday");
  });

  it("未設定 (null / undefined) は既定の timeline = 現状維持", () => {
    expect(normalizeOooAllDayPlacement(null)).toBe("timeline");
    expect(normalizeOooAllDayPlacement(undefined)).toBe("timeline");
  });

  it("空文字・空白だけの値も timeline に倒す", () => {
    expect(normalizeOooAllDayPlacement("")).toBe("timeline");
    expect(normalizeOooAllDayPlacement(" ")).toBe("timeline");
    expect(normalizeOooAllDayPlacement("\n")).toBe("timeline");
  });

  it("大文字・前後空白のゆらぎは受け付けない (完全一致のみ)", () => {
    expect(normalizeOooAllDayPlacement("AllDay")).toBe("timeline");
    expect(normalizeOooAllDayPlacement(" allday")).toBe("timeline");
    expect(normalizeOooAllDayPlacement("allday ")).toBe("timeline");
  });

  it("古いバージョン/手書きの想定外の値も timeline に倒す", () => {
    expect(normalizeOooAllDayPlacement("rail")).toBe("timeline");
    expect(normalizeOooAllDayPlacement("true")).toBe("timeline");
    expect(normalizeOooAllDayPlacement('{"placement":"allday"}')).toBe("timeline");
  });

  it("既定値の定数と一致する", () => {
    expect(normalizeOooAllDayPlacement(null)).toBe(DEFAULT_OOO_ALLDAY_PLACEMENT);
  });
});

describe("getOooAllDayPlacement / setOooAllDayPlacement", () => {
  it("保存した値を読み戻せる", () => {
    const storage = fakeStorage();
    setOooAllDayPlacement("allday", storage);
    expect(getOooAllDayPlacement(storage)).toBe("allday");
  });

  it("既定値 (timeline) を選ぶと保存値ごと消える(未設定と同じ状態に戻す)", () => {
    const storage = fakeStorage({ "kichijitsu:oooAllDayPlacement": "allday" });
    setOooAllDayPlacement("timeline", storage);
    expect(storage.map.has("kichijitsu:oooAllDayPlacement")).toBe(false);
    expect(getOooAllDayPlacement(storage)).toBe("timeline");
  });

  it("未設定・壊れた保存値はどちらも既定の timeline", () => {
    expect(getOooAllDayPlacement(fakeStorage())).toBe("timeline");
    expect(getOooAllDayPlacement(fakeStorage({ "kichijitsu:oooAllDayPlacement": "??" }))).toBe(
      "timeline",
    );
  });
});
