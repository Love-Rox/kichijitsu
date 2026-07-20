import { describe, expect, it } from "vite-plus/test";
import { packDayBars } from "./packDayBars";

interface Bar {
  id: string;
  start: number;
  end: number;
}

function bar(id: string, start: number, end: number): Bar {
  return { id, start, end };
}

function pack(items: Bar[]) {
  return packDayBars(
    items,
    (b) => b.start,
    (b) => b.end,
  );
}

describe("packDayBars", () => {
  it("重ならない区間は全て row 0 に詰める", () => {
    const items = [bar("a", 0, 1), bar("b", 2, 3), bar("c", 4, 6)];
    const result = pack(items);
    expect(result.every((r) => r.row === 0)).toBe(true);
  });

  it("隣接する日 (前の終了日の翌日から開始) は重ならない扱いで同じ行に置く", () => {
    // a: day0-2, b: day3-4 (day2 の翌日の day3 から開始なので重ならない)
    const items = [bar("a", 0, 2), bar("b", 3, 4)];
    const result = pack(items);
    const rowOf = (id: string) => result.find((r) => r.item.id === id)?.row;
    expect(rowOf("a")).toBe(0);
    expect(rowOf("b")).toBe(0);
  });

  it("重なる区間は別の行に分ける", () => {
    // a: day0-3, b: day2-5 は day2,3 で重なる
    const items = [bar("a", 0, 3), bar("b", 2, 5)];
    const result = pack(items);
    const rowOf = (id: string) => result.find((r) => r.item.id === id)?.row;
    expect(rowOf("a")).toBe(0);
    expect(rowOf("b")).toBe(1);
  });

  it("3件が全て同時に重なる場合は3行に分かれる", () => {
    const items = [bar("a", 0, 6), bar("b", 1, 5), bar("c", 2, 4)];
    const result = pack(items);
    const rows = result.map((r) => r.row).sort();
    expect(rows).toEqual([0, 1, 2]);
  });

  it("空いた行があれば再利用する(単調増加する行数にならない)", () => {
    // a: day0-1 (row0), b: day0-1 (row1, a と重なる),
    // c: day2-3 (a の終了後なので row0 を再利用できる)
    const items = [bar("a", 0, 1), bar("b", 0, 1), bar("c", 2, 3)];
    const result = pack(items);
    const rowOf = (id: string) => result.find((r) => r.item.id === id)?.row;
    expect(rowOf("a")).toBe(0);
    expect(rowOf("b")).toBe(1);
    expect(rowOf("c")).toBe(0);
  });

  it("入力順に関わらず開始日順にソートしてから詰める(決定的)", () => {
    const items = [bar("late", 5, 6), bar("early", 0, 1)];
    const result = pack(items);
    expect(result.every((r) => r.row === 0)).toBe(true);
  });

  it("空配列は空配列を返す", () => {
    expect(pack([])).toEqual([]);
  });

  it("単一日イベント (start === end) は自身とのみ重なり判定する", () => {
    const items = [bar("a", 3, 3), bar("b", 3, 3), bar("c", 4, 4)];
    const result = pack(items);
    const rowOf = (id: string) => result.find((r) => r.item.id === id)?.row;
    expect(rowOf("a")).toBe(0);
    expect(rowOf("b")).toBe(1); // a と同じ日なので重なる
    expect(rowOf("c")).toBe(0); // a の翌日なので row0 を再利用できる
  });
});
