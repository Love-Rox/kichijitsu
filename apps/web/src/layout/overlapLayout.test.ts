import { describe, expect, it } from "vite-plus/test";
import {
  CHIP_RESERVE_FRAC,
  layoutOverlaps,
  layoutOverlapsCapped,
  STACK_INDENT_FRAC,
  type OverlapInput,
} from "./overlapLayout";

const MIN = 60_000;
/** 見出しの窓 = 36 分(標準ズームで約 36px) */
const HEADER = 36 * MIN;

function ev(id: string, startMin: number, endMin: number, background = false): OverlapInput {
  return { id, startMs: startMin * MIN, endMs: endMin * MIN, background };
}

describe("layoutOverlaps", () => {
  it("重ならない予定は全幅で、列の左端に置く", () => {
    const r = layoutOverlaps([ev("a", 0, 60), ev("b", 60, 120)], HEADER);
    expect(r.get("a")).toMatchObject({ leftFrac: 0, widthFrac: 1 });
    expect(r.get("b")).toMatchObject({ leftFrac: 0, widthFrac: 1 });
  });

  it("同時に始まる予定は横に並べて等分する(見出しを覆わない)", () => {
    const r = layoutOverlaps([ev("a", 0, 60), ev("b", 0, 60)], HEADER);
    expect(r.get("a")).toMatchObject({ leftFrac: 0, widthFrac: 0.5 });
    expect(r.get("b")).toMatchObject({ leftFrac: 0.5, widthFrac: 0.5 });
  });

  it("見出しの窓の中で始まる予定も横に並べる", () => {
    const r = layoutOverlaps([ev("a", 0, 120), ev("b", 20, 80)], HEADER);
    expect(r.get("a")!.leftFrac).toBe(0);
    expect(r.get("b")!.leftFrac).toBeGreaterThan(0);
    // 重ならない: a の幅は b の左端まで
    expect(r.get("a")!.leftFrac + r.get("a")!.widthFrac).toBeLessThanOrEqual(r.get("b")!.leftFrac);
  });

  it("見出しの窓より後に始まる予定は、同じレーンで右に少しずらして乗る", () => {
    const r = layoutOverlaps([ev("a", 0, 180), ev("b", 90, 120)], HEADER);
    expect(r.get("a")).toMatchObject({ leftFrac: 0, widthFrac: 1 });
    expect(r.get("b")!.leftFrac).toBeCloseTo(STACK_INDENT_FRAC);
    expect(r.get("b")!.widthFrac).toBeCloseTo(1 - STACK_INDENT_FRAC);
    expect(r.get("b")!.stackIndex).toBeGreaterThan(r.get("a")!.stackIndex);
  });

  it("後から始まる予定は前面に出る", () => {
    const r = layoutOverlaps([ev("b", 90, 120), ev("a", 0, 180)], HEADER);
    expect(r.get("b")!.stackIndex).toBeGreaterThan(r.get("a")!.stackIndex);
  });

  it("右の空きレーンまで幅を広げる", () => {
    // a と b は同時開始で2レーン。c は b の終了後に始まるので、b のレーンも使って横に広がる
    const r = layoutOverlaps([ev("a", 0, 240), ev("b", 0, 60), ev("c", 120, 180)], HEADER);
    expect(r.get("b")).toMatchObject({ leftFrac: 0.5, widthFrac: 0.5 });
    const c = r.get("c")!;
    expect(c.leftFrac + c.widthFrac).toBeCloseTo(1);
  });

  it("背景層は全幅・最背面で、他の予定の幅を奪わない", () => {
    const r = layoutOverlaps(
      [ev("busy", 0, 120, true), ev("a", 0, 60), ev("b", 0, 60), ev("declined", 30, 90, true)],
      HEADER,
    );
    expect(r.get("busy")).toMatchObject({ leftFrac: 0, widthFrac: 1 });
    expect(r.get("declined")).toMatchObject({ leftFrac: 0, widthFrac: 1 });
    // a・b は背景を無視して2等分
    expect(r.get("a")).toMatchObject({ leftFrac: 0, widthFrac: 0.5 });
    expect(r.get("b")).toMatchObject({ leftFrac: 0.5, widthFrac: 0.5 });
    const bg = Math.max(r.get("busy")!.stackIndex, r.get("declined")!.stackIndex);
    expect(Math.min(r.get("a")!.stackIndex, r.get("b")!.stackIndex)).toBeGreaterThan(bg);
  });

  it("乗り合いが深くても、幅は下限を割らない", () => {
    const items = [ev("a", 0, 600)];
    for (let i = 1; i <= 8; i++) items.push(ev(`n${i}`, i * 60, 600));
    const r = layoutOverlaps(items, HEADER);
    for (const v of r.values()) expect(v.widthFrac).toBeGreaterThanOrEqual(0.3 - 1e-9);
  });

  it("どの予定も、列の外にはみ出さない", () => {
    const items = [
      ev("a", 0, 180),
      ev("b", 0, 60),
      ev("c", 10, 70),
      ev("d", 90, 150),
      ev("e", 95, 100),
      ev("f", 20, 400),
    ];
    for (const v of layoutOverlaps(items, HEADER).values()) {
      expect(v.leftFrac).toBeGreaterThanOrEqual(0);
      expect(v.leftFrac + v.widthFrac).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("見出しの窓が重なる2つの予定は、水平方向に重ならない", () => {
    const items = [ev("a", 0, 300), ev("b", 10, 200), ev("c", 20, 100), ev("d", 25, 30)];
    const r = layoutOverlaps(items, HEADER);
    const ids = items.map((i) => i.id);
    for (const x of ids)
      for (const y of ids) {
        if (x >= y) continue;
        const ix = items.find((i) => i.id === x)!;
        const iy = items.find((i) => i.id === y)!;
        const wx = [ix.startMs, ix.startMs + Math.min(HEADER, ix.endMs - ix.startMs)];
        const wy = [iy.startMs, iy.startMs + Math.min(HEADER, iy.endMs - iy.startMs)];
        if (!(wx[0] < wy[1] && wy[0] < wx[1])) continue;
        const sx = r.get(x)!;
        const sy = r.get(y)!;
        const overlapX = sx.leftFrac < sy.leftFrac + sy.widthFrac && sy.leftFrac < sx.leftFrac + sx.widthFrac;
        expect(overlapX, `${x} と ${y}`).toBe(false);
      }
  });
});

describe("layoutOverlapsCapped", () => {
  /** 同時に始まる 5 件(レーンが 5 本できる) */
  const five = [0, 1, 2, 3, 4].map((i) => ev(`e${i}`, 600, 660));

  it("上限を超えない塊は、layoutOverlaps と同じ配置で、隠さず、チップも出さない", () => {
    const items = [ev("a", 0, 60), ev("b", 0, 60), ev("c", 120, 180)];
    const capped = layoutOverlapsCapped(items, HEADER, { maxLanes: 3 });
    expect(capped.slots).toEqual(layoutOverlaps(items, HEADER));
    expect(capped.hidden.size).toBe(0);
    expect(capped.chips).toEqual([]);
  });

  it("上限を超えたレーンの予定を隠し、塊ごとに「+N」のチップを 1 つ出す", () => {
    const r = layoutOverlapsCapped(five, HEADER, { maxLanes: 3 });
    expect([...r.hidden].sort()).toEqual(["e3", "e4"]);
    expect(r.slots.has("e3")).toBe(false);
    expect(r.chips).toEqual([{ key: 600 * MIN, startMs: 600 * MIN, hiddenCount: 2, expanded: false }]);
  });

  it("見えるレーンは、チップの分を右端に空けて、残りを等分する(はみ出さない)", () => {
    const r = layoutOverlapsCapped(five, HEADER, { maxLanes: 3 });
    const usable = 1 - CHIP_RESERVE_FRAC;
    for (const [i, id] of ["e0", "e1", "e2"].entries()) {
      const slot = r.slots.get(id)!;
      expect(slot.leftFrac).toBeCloseTo((i / 3) * usable);
      expect(slot.widthFrac).toBeCloseTo(usable / 3);
    }
    const last = r.slots.get("e2")!;
    expect(last.leftFrac + last.widthFrac).toBeCloseTo(usable);
  });

  it("開いている塊は、上限なしで全部並べ、畳むためのチップだけを出す", () => {
    const r = layoutOverlapsCapped(five, HEADER, { maxLanes: 3, expanded: new Set([600 * MIN]) });
    expect(r.hidden.size).toBe(0);
    expect(r.slots.size).toBe(5);
    expect(r.chips).toEqual([{ key: 600 * MIN, startMs: 600 * MIN, hiddenCount: 0, expanded: true }]);
    expect(r.slots.get("e4")!.widthFrac).toBeCloseTo(1 / 5);
  });

  it("別の塊は、それぞれ別に数える(上限を超えない塊は、そのまま)", () => {
    const items = [...five, ev("x", 0, 30), ev("y", 0, 30)];
    const r = layoutOverlapsCapped(items, HEADER, { maxLanes: 3 });
    expect(r.chips).toHaveLength(1);
    expect(r.slots.get("x")).toMatchObject({ leftFrac: 0, widthFrac: 0.5 });
  });

  it("背景層は、数にも隠す対象にも入らない", () => {
    const r = layoutOverlapsCapped([...five, ev("bg", 0, 1440, true)], HEADER, { maxLanes: 3 });
    expect(r.hidden.has("bg")).toBe(false);
    expect(r.slots.get("bg")).toMatchObject({ leftFrac: 0, widthFrac: 1 });
  });

  it("隠れた予定が後ろの予定の幅の広がりを止めない(見えるレーンだけで、右へ広げる)", () => {
    // a と b が先に重なり、c(隠れる 4 本目より前)の右は空き、という並びの確認として、全体が重ならない
    const items = [ev("a", 0, 120), ev("b", 0, 120), ev("c", 0, 120), ev("d", 0, 120)];
    const r = layoutOverlapsCapped(items, HEADER, { maxLanes: 3 });
    const visible = ["a", "b", "c"].map((id) => r.slots.get(id)!);
    for (let i = 1; i < visible.length; i++) {
      expect(visible[i].leftFrac).toBeGreaterThanOrEqual(visible[i - 1].leftFrac + visible[i - 1].widthFrac - 1e-9);
    }
  });
});
