import { describe, expect, it } from "vite-plus/test";
import type { Occurrence } from "../model/types";
import { hasOccurrenceTimeChanged } from "./moveConfirm";

function occ(overrides: Partial<Occurrence> = {}): Occurrence {
  return {
    id: "g:acc-1:cal-1:evt-1",
    seriesId: null,
    title: "Test",
    startMs: 1_000,
    endMs: 2_000,
    color: "#3b82f6",
    source: "google",
    ...overrides,
  };
}

describe("hasOccurrenceTimeChanged", () => {
  it("startMs/endMs がともに同じなら false", () => {
    expect(hasOccurrenceTimeChanged(occ(), occ())).toBe(false);
  });

  it("startMs が変われば true", () => {
    expect(hasOccurrenceTimeChanged(occ(), occ({ startMs: 1_500 }))).toBe(true);
  });

  it("endMs が変われば true(リサイズのケース)", () => {
    expect(hasOccurrenceTimeChanged(occ(), occ({ endMs: 2_500 }))).toBe(true);
  });

  it("他フィールドだけが変わっても時刻が同じなら false", () => {
    expect(hasOccurrenceTimeChanged(occ(), occ({ title: "Renamed" }))).toBe(false);
  });
});
