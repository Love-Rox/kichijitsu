import { describe, expect, it } from "vite-plus/test";
import { computeFreeSlots } from "../src/core/free-slots";

// 2024-01-01T00:00:00Z を day1 の起点、2024-01-02T00:00:00Z を day2 の起点とする。
const day1 = Date.UTC(2024, 0, 1);
const day2 = Date.UTC(2024, 0, 2);
const HOUR = 60 * 60 * 1000;
const h1 = (hour: number) => day1 + hour * HOUR;
const h2 = (hour: number) => day2 + hour * HOUR;

describe("computeFreeSlots", () => {
  it("returns the whole range as a single slot when there is no busy interval", () => {
    const slots = computeFreeSlots({
      busy: [],
      rangeStartMs: h1(9),
      rangeEndMs: h1(17),
      durationMs: 30 * 60_000,
    });
    expect(slots).toEqual([{ startMs: h1(9), endMs: h1(9) + 30 * 60_000 }]);
  });

  it("splits the range into before/after gaps around a single busy event", () => {
    const slots = computeFreeSlots({
      busy: [{ startMs: h1(10), endMs: h1(11) }],
      rangeStartMs: h1(9),
      rangeEndMs: h1(17),
      durationMs: 30 * 60_000,
    });
    expect(slots).toEqual([
      { startMs: h1(9), endMs: h1(9) + 30 * 60_000 },
      { startMs: h1(11), endMs: h1(11) + 30 * 60_000 },
    ]);
  });

  it("merges overlapping busy events before computing gaps", () => {
    const slots = computeFreeSlots({
      busy: [
        { startMs: h1(10), endMs: h1(12) },
        { startMs: h1(11), endMs: h1(13) },
      ],
      rangeStartMs: h1(9),
      rangeEndMs: h1(17),
      durationMs: 30 * 60_000,
    });
    // merged busy is [10,13) -> gaps are [9,10) and [13,17)
    expect(slots).toEqual([
      { startMs: h1(9), endMs: h1(9) + 30 * 60_000 },
      { startMs: h1(13), endMs: h1(13) + 30 * 60_000 },
    ]);
  });

  it("produces no zero-length gap between touching busy events", () => {
    const slots = computeFreeSlots({
      busy: [
        { startMs: h1(10), endMs: h1(11) },
        { startMs: h1(11), endMs: h1(12) },
      ],
      rangeStartMs: h1(9),
      rangeEndMs: h1(17),
      durationMs: 15 * 60_000,
    });
    // merged busy is [10,12); the only gaps should be [9,10) and [12,17) — no zero-length
    // gap emitted at the 11:00 touch point.
    expect(slots).toEqual([
      { startMs: h1(9), endMs: h1(9) + 15 * 60_000 },
      { startMs: h1(12), endMs: h1(12) + 15 * 60_000 },
    ]);
  });

  it("returns an empty array when busy fully covers the range", () => {
    const slots = computeFreeSlots({
      busy: [{ startMs: h1(0), endMs: h1(24) }],
      rangeStartMs: h1(9),
      rangeEndMs: h1(17),
      durationMs: 30 * 60_000,
    });
    expect(slots).toEqual([]);
  });

  it("returns an empty array when the requested duration is longer than every gap", () => {
    const slots = computeFreeSlots({
      busy: [{ startMs: h1(10), endMs: h1(11) }],
      rangeStartMs: h1(9),
      rangeEndMs: h1(11), // range ends right when busy ends, no time after
      durationMs: 5 * HOUR,
    });
    expect(slots).toEqual([]);
  });

  it("ignores busy events entirely outside the range", () => {
    const slots = computeFreeSlots({
      busy: [{ startMs: h1(1), endMs: h1(2) }],
      rangeStartMs: h1(9),
      rangeEndMs: h1(17),
      durationMs: 30 * 60_000,
    });
    expect(slots).toEqual([{ startMs: h1(9), endMs: h1(9) + 30 * 60_000 }]);
  });

  it("returns [] for an invalid range (start >= end)", () => {
    expect(
      computeFreeSlots({ busy: [], rangeStartMs: h1(17), rangeEndMs: h1(9), durationMs: 1000 }),
    ).toEqual([]);
    expect(
      computeFreeSlots({ busy: [], rangeStartMs: h1(9), rangeEndMs: h1(9), durationMs: 1000 }),
    ).toEqual([]);
  });

  it("returns [] for a non-positive duration", () => {
    expect(
      computeFreeSlots({ busy: [], rangeStartMs: h1(9), rangeEndMs: h1(17), durationMs: 0 }),
    ).toEqual([]);
    expect(
      computeFreeSlots({ busy: [], rangeStartMs: h1(9), rangeEndMs: h1(17), durationMs: -1000 }),
    ).toEqual([]);
  });

  it("restricts gaps to per-day working hours across a multi-day range", () => {
    // range spans day1 09:00 -> day2 17:00, no busy events. workingHours 09-17 should produce
    // one slot on day1 (09:00-...) and one slot on day2 (09:00-...) — the overnight span
    // (day1 17:00 -> day2 09:00) falls entirely outside working hours and is excluded.
    const slots = computeFreeSlots({
      busy: [],
      rangeStartMs: h1(9),
      rangeEndMs: h2(17),
      durationMs: 60 * 60_000,
      workingHours: { startHour: 9, endHour: 17 },
    });
    expect(slots).toEqual([
      { startMs: h1(9), endMs: h1(9) + 60 * 60_000 },
      { startMs: h2(9), endMs: h2(9) + 60 * 60_000 },
    ]);
  });

  it("excludes a gap that falls entirely outside working hours", () => {
    // A busy event from 09:00-17:00 leaves only the overnight gap in range, which working
    // hours 09-17 entirely excludes.
    const slots = computeFreeSlots({
      busy: [{ startMs: h1(9), endMs: h1(17) }],
      rangeStartMs: h1(9),
      rangeEndMs: h1(20),
      durationMs: 30 * 60_000,
      workingHours: { startHour: 9, endHour: 17 },
    });
    expect(slots).toEqual([]);
  });
});
