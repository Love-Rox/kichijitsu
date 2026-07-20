import { describe, expect, it } from "vite-plus/test";
import { Temporal } from "@js-temporal/polyfill";
import { expandSeries } from "./expandSeries";
import type { EventSeries, InstanceOverride } from "../model/series";
import { instanceId } from "../model/series";

/** 壁時計 ISO ("2026-01-01T09:00") + IANA タイムゾーンから epoch ms を求めるテスト用ヘルパー */
function zms(iso: string, timeZone: string): number {
  return Temporal.PlainDateTime.from(iso).toZonedDateTime(timeZone).epochMilliseconds;
}

const FAR_FUTURE = zms("2100-01-01T00:00", "UTC");
const FAR_PAST = zms("2000-01-01T00:00", "UTC");

function baseSeries(overrides: Partial<EventSeries> = {}): EventSeries {
  return {
    id: "series-1",
    title: "Test Event",
    color: "#123456",
    source: "local",
    dtstartIso: "2026-01-01T09:00",
    timeZone: "Asia/Tokyo",
    durationMin: 60,
    rrule: "FREQ=DAILY",
    exdatesMs: [],
    ...overrides,
  };
}

describe("expandSeries", () => {
  it("FREQ=DAILY + COUNT", () => {
    const series = baseSeries({ rrule: "FREQ=DAILY;COUNT=3" });
    const result = expandSeries({
      series,
      overrides: [],
      windowStartMs: FAR_PAST,
      windowEndMs: FAR_FUTURE,
    });

    expect(result.map((o) => o.startMs)).toEqual([
      zms("2026-01-01T09:00", "Asia/Tokyo"),
      zms("2026-01-02T09:00", "Asia/Tokyo"),
      zms("2026-01-03T09:00", "Asia/Tokyo"),
    ]);
    for (const occ of result) {
      expect(occ.endMs - occ.startMs).toBe(60 * 60_000);
      expect(occ.seriesId).toBe("series-1");
      expect(occ.title).toBe("Test Event");
    }
  });

  it("hasCustomColor を series からそのまま occurrence へ伝播する(色バグ修正 2026-07-20)", () => {
    const customColorSeries = baseSeries({
      id: "series-custom",
      hasCustomColor: true,
      rrule: "FREQ=DAILY;COUNT=1",
    });
    const noCustomColorSeries = baseSeries({
      id: "series-no-custom",
      hasCustomColor: false,
      rrule: "FREQ=DAILY;COUNT=1",
    });
    const undefinedSeries = baseSeries({ id: "series-undefined", rrule: "FREQ=DAILY;COUNT=1" });

    const resultCustom = expandSeries({
      series: customColorSeries,
      overrides: [],
      windowStartMs: FAR_PAST,
      windowEndMs: FAR_FUTURE,
    });
    const resultNoCustom = expandSeries({
      series: noCustomColorSeries,
      overrides: [],
      windowStartMs: FAR_PAST,
      windowEndMs: FAR_FUTURE,
    });
    const resultUndefined = expandSeries({
      series: undefinedSeries,
      overrides: [],
      windowStartMs: FAR_PAST,
      windowEndMs: FAR_FUTURE,
    });

    expect(resultCustom[0].hasCustomColor).toBe(true);
    expect(resultNoCustom[0].hasCustomColor).toBe(false);
    expect(resultUndefined[0].hasCustomColor).toBeUndefined();
  });

  it("FREQ=WEEKLY + BYDAY 複数曜日 + INTERVAL=2 (隔週)", () => {
    // 2026-01-05 は月曜
    const series = baseSeries({
      dtstartIso: "2026-01-05T10:00",
      rrule: "FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2;COUNT=4",
    });
    const result = expandSeries({
      series,
      overrides: [],
      windowStartMs: FAR_PAST,
      windowEndMs: FAR_FUTURE,
    });

    expect(result.map((o) => o.startMs)).toEqual([
      zms("2026-01-05T10:00", "Asia/Tokyo"), // Mon (week 0)
      zms("2026-01-07T10:00", "Asia/Tokyo"), // Wed (week 0)
      zms("2026-01-19T10:00", "Asia/Tokyo"), // Mon (week 0 + 2 weeks)
      zms("2026-01-21T10:00", "Asia/Tokyo"), // Wed (week 0 + 2 weeks)
    ]);
  });

  it("FREQ=MONTHLY + BYDAY=2TU (第2火曜)", () => {
    const series = baseSeries({
      dtstartIso: "2026-01-01T09:00",
      rrule: "FREQ=MONTHLY;BYDAY=2TU;COUNT=3",
    });
    const result = expandSeries({
      series,
      overrides: [],
      windowStartMs: FAR_PAST,
      windowEndMs: FAR_FUTURE,
    });

    expect(result.map((o) => o.startMs)).toEqual([
      zms("2026-01-13T09:00", "Asia/Tokyo"),
      zms("2026-02-10T09:00", "Asia/Tokyo"),
      zms("2026-03-10T09:00", "Asia/Tokyo"),
    ]);
  });

  it("FREQ=MONTHLY + BYDAY=-1FR (最終金曜)", () => {
    const series = baseSeries({
      dtstartIso: "2026-01-01T09:00",
      rrule: "FREQ=MONTHLY;BYDAY=-1FR;COUNT=3",
    });
    const result = expandSeries({
      series,
      overrides: [],
      windowStartMs: FAR_PAST,
      windowEndMs: FAR_FUTURE,
    });

    expect(result.map((o) => o.startMs)).toEqual([
      zms("2026-01-30T09:00", "Asia/Tokyo"),
      zms("2026-02-27T09:00", "Asia/Tokyo"),
      zms("2026-03-27T09:00", "Asia/Tokyo"),
    ]);
  });

  it("FREQ=MONTHLY + BYMONTHDAY=31 (31日が無い月はスキップされる)", () => {
    const series = baseSeries({
      dtstartIso: "2026-01-31T09:00",
      rrule: "FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3",
    });
    const result = expandSeries({
      series,
      overrides: [],
      windowStartMs: FAR_PAST,
      windowEndMs: FAR_FUTURE,
    });

    // Feb (28日), Apr (30日) はスキップされる
    expect(result.map((o) => o.startMs)).toEqual([
      zms("2026-01-31T09:00", "Asia/Tokyo"),
      zms("2026-03-31T09:00", "Asia/Tokyo"),
      zms("2026-05-31T09:00", "Asia/Tokyo"),
    ]);
  });

  describe("UNTIL の inclusive 境界", () => {
    it("日付のみ形式 (YYYYMMDD): 当日の回は含み翌日は含まない", () => {
      const series = baseSeries({
        dtstartIso: "2026-01-01T00:00",
        timeZone: "UTC",
        rrule: "FREQ=DAILY;UNTIL=20260103",
      });
      const result = expandSeries({
        series,
        overrides: [],
        windowStartMs: FAR_PAST,
        windowEndMs: FAR_FUTURE,
      });

      expect(result.map((o) => o.startMs)).toEqual([
        zms("2026-01-01T00:00", "UTC"),
        zms("2026-01-02T00:00", "UTC"),
        zms("2026-01-03T00:00", "UTC"),
      ]);
    });

    it("UTC instant 形式 (YYYYMMDDTHHMMSSZ): 一致する回は含み次の回は含まない", () => {
      const series = baseSeries({
        dtstartIso: "2026-01-01T00:00",
        timeZone: "UTC",
        rrule: "FREQ=DAILY;UNTIL=20260103T000000Z",
      });
      const result = expandSeries({
        series,
        overrides: [],
        windowStartMs: FAR_PAST,
        windowEndMs: FAR_FUTURE,
      });

      expect(result.map((o) => o.startMs)).toEqual([
        zms("2026-01-01T00:00", "UTC"),
        zms("2026-01-02T00:00", "UTC"),
        zms("2026-01-03T00:00", "UTC"),
      ]);
    });
  });

  it("DST 跨ぎ: America/New_York の FREQ=WEEKLY 9:00 は壁時計 9:00 を保つ", () => {
    // 2026-03-08 に America/New_York で spring forward (夏時間開始) が発生する
    const series = baseSeries({
      dtstartIso: "2026-03-01T09:00",
      timeZone: "America/New_York",
      rrule: "FREQ=WEEKLY;COUNT=3",
    });
    const result = expandSeries({
      series,
      overrides: [],
      windowStartMs: FAR_PAST,
      windowEndMs: FAR_FUTURE,
    });

    const expectedMs = [
      zms("2026-03-01T09:00", "America/New_York"),
      zms("2026-03-08T09:00", "America/New_York"),
      zms("2026-03-15T09:00", "America/New_York"),
    ];
    expect(result.map((o) => o.startMs)).toEqual(expectedMs);

    // 壁時計 9:00 は保たれるが、DST を跨ぐ週の epoch ms 差はちょうど1週間 (604800000ms) にはならない
    const diffAcrossDst = result[1].startMs - result[0].startMs;
    const diffNoDst = result[2].startMs - result[1].startMs;
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
    expect(diffAcrossDst).not.toBe(oneWeekMs);
    expect(diffAcrossDst).toBe(oneWeekMs - 60 * 60 * 1000); // 1時間短い
    expect(diffNoDst).toBe(oneWeekMs); // DST を跨がない週は通常通り

    // 壁時計の時刻そのものは常に 9:00 のまま
    for (const occ of result) {
      const zdt = Temporal.Instant.fromEpochMilliseconds(occ.startMs).toZonedDateTimeISO(
        "America/New_York",
      );
      expect(zdt.hour).toBe(9);
      expect(zdt.minute).toBe(0);
    }
  });

  it("EXDATE で指定回が消える", () => {
    const series = baseSeries({ rrule: "FREQ=DAILY;COUNT=3" });
    const excludedMs = zms("2026-01-02T09:00", "Asia/Tokyo");
    series.exdatesMs = [excludedMs];

    const result = expandSeries({
      series,
      overrides: [],
      windowStartMs: FAR_PAST,
      windowEndMs: FAR_FUTURE,
    });

    expect(result.map((o) => o.startMs)).toEqual([
      zms("2026-01-01T09:00", "Asia/Tokyo"),
      zms("2026-01-03T09:00", "Asia/Tokyo"),
    ]);
  });

  describe("override", () => {
    it("startMs/endMs patch で時刻変更", () => {
      const series = baseSeries({ rrule: "FREQ=DAILY;COUNT=3" });
      const originalStartMs = zms("2026-01-02T09:00", "Asia/Tokyo");
      const newStartMs = zms("2026-01-02T15:00", "Asia/Tokyo");
      const newEndMs = newStartMs + 30 * 60_000;

      const overrides: InstanceOverride[] = [
        {
          id: instanceId(series.id, originalStartMs),
          seriesId: series.id,
          originalStartMs,
          patch: { startMs: newStartMs, endMs: newEndMs },
        },
      ];

      const result = expandSeries({
        series,
        overrides,
        windowStartMs: FAR_PAST,
        windowEndMs: FAR_FUTURE,
      });

      const moved = result.find((o) => o.originalStartMs === originalStartMs);
      expect(moved).toBeDefined();
      expect(moved!.startMs).toBe(newStartMs);
      expect(moved!.endMs).toBe(newEndMs);
      expect(moved!.id).toBe(instanceId(series.id, originalStartMs));
    });

    it("endMs だけ patch された場合 startMs は元のまま", () => {
      const series = baseSeries({ rrule: "FREQ=DAILY;COUNT=3" });
      const originalStartMs = zms("2026-01-02T09:00", "Asia/Tokyo");
      const newEndMs = originalStartMs + 3 * 60 * 60_000;

      const overrides: InstanceOverride[] = [
        {
          id: instanceId(series.id, originalStartMs),
          seriesId: series.id,
          originalStartMs,
          patch: { endMs: newEndMs },
        },
      ];

      const result = expandSeries({
        series,
        overrides,
        windowStartMs: FAR_PAST,
        windowEndMs: FAR_FUTURE,
      });

      const patched = result.find((o) => o.originalStartMs === originalStartMs);
      expect(patched).toBeDefined();
      expect(patched!.startMs).toBe(originalStartMs);
      expect(patched!.endMs).toBe(newEndMs);
    });

    it("patch === null でその回はキャンセル(除外)される", () => {
      const series = baseSeries({ rrule: "FREQ=DAILY;COUNT=3" });
      const cancelledMs = zms("2026-01-02T09:00", "Asia/Tokyo");

      const overrides: InstanceOverride[] = [
        {
          id: instanceId(series.id, cancelledMs),
          seriesId: series.id,
          originalStartMs: cancelledMs,
          patch: null,
        },
      ];

      const result = expandSeries({
        series,
        overrides,
        windowStartMs: FAR_PAST,
        windowEndMs: FAR_FUTURE,
      });

      expect(result.map((o) => o.startMs)).toEqual([
        zms("2026-01-01T09:00", "Asia/Tokyo"),
        zms("2026-01-03T09:00", "Asia/Tokyo"),
      ]);
      expect(result.some((o) => o.originalStartMs === cancelledMs)).toBe(false);
    });
  });

  describe("ウィンドウフィルタ", () => {
    it("範囲外の occurrence は含まれない", () => {
      const series = baseSeries({ rrule: "FREQ=DAILY;COUNT=5" });
      const windowStartMs = zms("2026-01-02T00:00", "Asia/Tokyo");
      const windowEndMs = zms("2026-01-04T00:00", "Asia/Tokyo");

      const result = expandSeries({ series, overrides: [], windowStartMs, windowEndMs });

      expect(result.map((o) => o.startMs)).toEqual([
        zms("2026-01-02T09:00", "Asia/Tokyo"),
        zms("2026-01-03T09:00", "Asia/Tokyo"),
      ]);
    });

    it("境界は半開区間 [from, to)", () => {
      const series = baseSeries({ rrule: "FREQ=DAILY;COUNT=3" });
      // windowStart はちょうど2回目の開始時刻、windowEnd はちょうど3回目の開始時刻
      const windowStartMs = zms("2026-01-02T09:00", "Asia/Tokyo");
      const windowEndMs = zms("2026-01-03T09:00", "Asia/Tokyo");

      const result = expandSeries({ series, overrides: [], windowStartMs, windowEndMs });

      // windowStartMs は含む (>=)、windowEndMs は含まない (<)
      expect(result.map((o) => o.startMs)).toEqual([zms("2026-01-02T09:00", "Asia/Tokyo")]);
    });
  });

  it("未対応の FREQ は throw する", () => {
    const series = baseSeries({ rrule: "FREQ=HOURLY" });
    expect(() =>
      expandSeries({
        series,
        overrides: [],
        windowStartMs: FAR_PAST,
        windowEndMs: FAR_FUTURE,
      }),
    ).toThrow();
  });
});
