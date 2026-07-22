import { describe, expect, it } from "vite-plus/test";
import { RAIL_BAND_WIDTH_PX } from "./gridMetrics";
import { packRailBandColumns } from "./railStack";

/** テスト用の最小の帯アイテム。id は結果の対応付け確認に使う */
interface Band {
  id: string;
  startMinutes: number;
  endMinutes: number;
}

function band(id: string, startMinutes: number, endMinutes: number): Band {
  return { id, startMinutes, endMinutes };
}

function pack(items: Band[]) {
  return packRailBandColumns(
    items,
    (b) => b.startMinutes,
    (b) => b.endMinutes,
  );
}

/** id → column の Map に変換して assert しやすくする */
function columnsById(positioned: ReturnType<typeof pack>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of positioned) out[p.item.id] = p.column;
  return out;
}

describe("packRailBandColumns", () => {
  it("接触(A の終了 === B の開始)は重ならない扱いで同じ列(縦に並ぶ)", () => {
    // 30分ずつなので表示上の最低高さ(16px ≒ 20分)を下回らず、底上げの影響を受けない
    const a = band("a", 0, 30);
    const b = band("b", 30, 60);
    const result = pack([a, b]);
    expect(columnsById(result)).toEqual({ a: 0, b: 0 });
    // 同じ列 = 本来の時刻位置のまま縦に並ぶだけなので、両方とも列数1
    for (const p of result) expect(p.columnCount).toBe(1);
  });

  it("部分的に重なる帯は別々の列(横に並ぶ)", () => {
    const a = band("a", 0, 30);
    const b = band("b", 15, 45);
    const result = pack([a, b]);
    const cols = columnsById(result);
    expect(cols.a).not.toBe(cols.b);
    expect(new Set(Object.values(cols))).toEqual(new Set([0, 1]));
    for (const p of result) expect(p.columnCount).toBe(2);
  });

  it("完全に重なる(同一区間)帯は別々の列(横に並ぶ)", () => {
    const a = band("a", 0, 30);
    const b = band("b", 0, 30);
    const result = pack([a, b]);
    const cols = columnsById(result);
    expect(cols.a).not.toBe(cols.b);
    for (const p of result) expect(p.columnCount).toBe(2);
  });

  it("長さ0(start===end)の同時刻の点は表示上の最低高さぶんで重なる扱いになり別列(横)", () => {
    const a = band("a", 10, 10);
    const b = band("b", 10, 10);
    const result = pack([a, b]);
    const cols = columnsById(result);
    expect(cols.a).not.toBe(cols.b);
    for (const p of result) expect(p.columnCount).toBe(2);
  });

  it("先に渡した方(OOO を先に並べる呼び出し規約)が同時刻タイで列0(左)に来る", () => {
    // DayColumn.tsx は OOO → 勤務場所の順で配列を組み立てて渡す。ここでは
    // その規約どおり ooo を先に渡し、列0に来ることを確認する。
    const ooo = band("ooo", 10, 10);
    const workloc = band("workloc", 10, 10);
    const result = pack([ooo, workloc]);
    const cols = columnsById(result);
    expect(cols.ooo).toBe(0);
    expect(cols.workloc).toBe(1);
  });

  it("3つが互いに重なれば3列に分かれる", () => {
    const a = band("a", 0, 60);
    const b = band("b", 0, 60);
    const c = band("c", 0, 60);
    const result = pack([a, b, c]);
    const cols = columnsById(result);
    expect(new Set(Object.values(cols))).toEqual(new Set([0, 1, 2]));
    for (const p of result) expect(p.columnCount).toBe(3);
  });

  it("重なりの無い複数の帯はすべて同じ列(縦に並ぶ)", () => {
    const a = band("a", 0, 30);
    const b = band("b", 40, 70);
    const c = band("c", 80, 110);
    const result = pack([a, b, c]);
    expect(columnsById(result)).toEqual({ a: 0, b: 0, c: 0 });
    for (const p of result) expect(p.columnCount).toBe(1);
  });

  it("column から left(px)を計算できる(RAIL_BAND_WIDTH_PX 刻み)", () => {
    const a = band("a", 0, 30);
    const b = band("b", 15, 45);
    const result = pack([a, b]);
    const lefts = result.map((p) => p.column * RAIL_BAND_WIDTH_PX);
    expect(new Set(lefts)).toEqual(new Set([0, RAIL_BAND_WIDTH_PX]));
  });
});
