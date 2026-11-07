import { describe, expect, it } from "vite-plus/test";
import { initialScrollTop } from "./initialScroll";
import { minutesToPx } from "./gridMetrics";

const H = 60; // 1時間あたりの高さ
const VIEW = 600; // 10時間ぶん

describe("initialScrollTop", () => {
  it("今日が範囲に無ければ朝8時を上端にする", () => {
    expect(initialScrollTop(null, H, VIEW)).toBe(minutesToPx(8 * 60, H));
  });

  it("8時基準で現在時刻が見えるなら動かさない", () => {
    expect(initialScrollTop(13 * 60, H, VIEW)).toBe(minutesToPx(8 * 60, H));
  });

  it("夜で見えないときは現在時刻が上から1/3に来る", () => {
    expect(initialScrollTop(22 * 60, H, VIEW)).toBe(minutesToPx(22 * 60, H) - VIEW / 3);
  });

  it("早朝で見えないときも現在時刻が見え、0 を下回らない", () => {
    expect(initialScrollTop(1 * 60, H, VIEW)).toBe(0);
    expect(initialScrollTop(6 * 60, H, VIEW)).toBe(minutesToPx(6 * 60, H) - VIEW / 3);
  });

  it("上端ぎりぎり(余白内)は見えていないものとして動かす", () => {
    expect(initialScrollTop(8 * 60, H, VIEW)).toBe(minutesToPx(8 * 60, H) - VIEW / 3);
  });

  it("ビューポートの高さが測れないときは基準のまま", () => {
    expect(initialScrollTop(22 * 60, H, 0)).toBe(minutesToPx(8 * 60, H));
  });
});
