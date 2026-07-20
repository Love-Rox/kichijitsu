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
      maxCandidates: 1,
    });
    expect(slots).toEqual([{ startMs: h1(9), endMs: h1(9) + 30 * 60_000 }]);
  });

  it("splits the range into before/after gaps around a single busy event", () => {
    const slots = computeFreeSlots({
      busy: [{ startMs: h1(10), endMs: h1(11) }],
      rangeStartMs: h1(9),
      rangeEndMs: h1(17),
      durationMs: 30 * 60_000,
      // gap ([9,10) と [11,17)) はどちらも duration より広いので、デフォルトの stepMinutes
      // だと gap ごとに複数候補が出てしまう (それ自体は別 describe で検証する)。ここでは
      // 純粋に gap 分割を検証したいので、stepMinutes を各 gap 幅より大きくして
      // gap ごとに最速の1件だけが出るようにする。
      stepMinutes: 24 * 60,
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
      stepMinutes: 24 * 60,
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
      stepMinutes: 24 * 60,
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
      maxCandidates: 1,
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
      // 各日の working-hours sub-gap (8時間) は duration (1時間) より広いので、gap 分割の
      // 検証に絞るため stepMinutes を sub-gap 幅より大きくして日ごとに1件だけにする。
      stepMinutes: 24 * 60,
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

describe("computeFreeSlots stepping and candidate cap", () => {
  it("defaults to 30-minute steps capped at 10 candidates when a single gap is large", () => {
    const slots = computeFreeSlots({
      busy: [],
      rangeStartMs: h1(9),
      rangeEndMs: h1(19), // 10 hour gap, room for far more than 10 candidates at 30-min steps
      durationMs: 30 * 60_000,
    });
    expect(slots).toHaveLength(10);
    expect(slots).toEqual(
      Array.from({ length: 10 }, (_, i) => ({
        startMs: h1(9) + i * 30 * 60_000,
        endMs: h1(9) + i * 30 * 60_000 + 30 * 60_000,
      })),
    );
  });

  it("spaces candidates by a custom stepMinutes", () => {
    const slots = computeFreeSlots({
      busy: [],
      rangeStartMs: h1(9),
      rangeEndMs: h1(13), // 4 hour gap
      durationMs: 30 * 60_000,
      stepMinutes: 45,
      maxCandidates: 10,
    });
    // gap is 240 min wide; candidates at offsets 0,45,90,135,180 (225+30=255 > 240, excluded)
    expect(slots).toEqual(
      [0, 45, 90, 135, 180].map((offsetMinutes) => ({
        startMs: h1(9) + offsetMinutes * 60_000,
        endMs: h1(9) + offsetMinutes * 60_000 + 30 * 60_000,
      })),
    );
  });

  it("truncates at maxCandidates across multiple gaps, taking the earliest candidates overall (not per gap)", () => {
    const slots = computeFreeSlots({
      // gap1 = [9:00, 10:30) (90 min, room for 3 candidates at 30-min steps);
      // gap2 = [11:00, 20:00) (540 min, room for far more than 2 candidates).
      busy: [{ startMs: h1(10.5), endMs: h1(11) }],
      rangeStartMs: h1(9),
      rangeEndMs: h1(20),
      durationMs: 30 * 60_000,
      maxCandidates: 5,
    });
    // gap1 contributes all 3 of its candidates (9:00, 9:30, 10:00); the remaining budget of 2
    // is spent on the earliest candidates from gap2 (11:00, 11:30), not gap2's full capacity.
    expect(slots).toEqual([
      { startMs: h1(9), endMs: h1(9) + 30 * 60_000 },
      { startMs: h1(9.5), endMs: h1(9.5) + 30 * 60_000 },
      { startMs: h1(10), endMs: h1(10) + 30 * 60_000 },
      { startMs: h1(11), endMs: h1(11) + 30 * 60_000 },
      { startMs: h1(11.5), endMs: h1(11.5) + 30 * 60_000 },
    ]);
  });

  it("excludes an overflowing last candidate that doesn't fit evenly into the gap", () => {
    const slots = computeFreeSlots({
      busy: [],
      // 100-minute gap; duration 30 min, step 30 min -> candidates at 0, 30, 60 (a candidate
      // at 90 would end at 120, past the 100-minute gap end, so it must be excluded).
      rangeStartMs: h1(9),
      rangeEndMs: h1(9) + 100 * 60_000,
      durationMs: 30 * 60_000,
    });
    expect(slots).toEqual([
      { startMs: h1(9), endMs: h1(9) + 30 * 60_000 },
      { startMs: h1(9) + 30 * 60_000, endMs: h1(9) + 60 * 60_000 },
      { startMs: h1(9) + 60 * 60_000, endMs: h1(9) + 90 * 60_000 },
    ]);
  });

  it("steps within working-hours sub-gaps across multiple days", () => {
    const slots = computeFreeSlots({
      busy: [],
      rangeStartMs: h1(9),
      rangeEndMs: h2(17),
      durationMs: 60 * 60_000,
      workingHours: { startHour: 9, endHour: 17 },
      stepMinutes: 120,
      maxCandidates: 10,
    });
    // each day's working-hours sub-gap is 8 hours (480 min); with a 60-min duration and
    // 120-min step, candidates land at offsets 0,120,240,360 within each day's window.
    const perDayOffsetsMinutes = [0, 120, 240, 360];
    expect(slots).toEqual([
      ...perDayOffsetsMinutes.map((offsetMinutes) => ({
        startMs: h1(9) + offsetMinutes * 60_000,
        endMs: h1(9) + offsetMinutes * 60_000 + 60 * 60_000,
      })),
      ...perDayOffsetsMinutes.map((offsetMinutes) => ({
        startMs: h2(9) + offsetMinutes * 60_000,
        endMs: h2(9) + offsetMinutes * 60_000 + 60 * 60_000,
      })),
    ]);
  });
});
