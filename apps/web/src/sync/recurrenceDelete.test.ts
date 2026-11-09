import { describe, expect, it } from "vite-plus/test";
import { Temporal } from "@js-temporal/polyfill";
import { expandSeries } from "../expansion/expandSeries";
import { instanceId, type EventSeries, type InstanceOverride } from "../model/series";
import type { Occurrence } from "../model/types";
import { buildSeriesDeleteRequest, instancesInRange, isRecurringGoogleOccurrence } from "./recurrenceDelete";

const TZ = "Asia/Tokyo";
const SERIES_ID = "g:acc:cal:evt1";

const series: EventSeries = {
  id: SERIES_ID,
  title: "朝会",
  color: "#123456",
  source: "google",
  accountId: "acc",
  calendarId: "cal",
  dtstartIso: "2026-11-01T09:00",
  timeZone: TZ,
  durationMin: 30,
  rrule: "FREQ=DAILY",
  exdatesMs: [],
};

function occurrences(overrides: InstanceOverride[] = []): Occurrence[] {
  const from = Temporal.PlainDate.from("2026-10-30").toZonedDateTime(TZ).epochMilliseconds;
  const to = Temporal.PlainDate.from("2026-12-01").toZonedDateTime(TZ).epochMilliseconds;
  return expandSeries({ series, overrides, windowStartMs: from, windowEndMs: to });
}

function pick(day: string, overrides: InstanceOverride[] = []): Occurrence {
  const o = occurrences(overrides).find(
    (x) => Temporal.Instant.fromEpochMilliseconds(x.startMs).toZonedDateTimeISO(TZ).toPlainDate().toString() === day,
  );
  if (!o) throw new Error(`no occurrence on ${day}`);
  return o;
}

function days(list: Occurrence[]): string[] {
  return list.map((o) =>
    Temporal.Instant.fromEpochMilliseconds(o.startMs).toZonedDateTimeISO(TZ).toPlainDate().toString(),
  );
}

describe("instancesInRange", () => {
  it("この回から指定の日まで(両端を含む)の回を返す", () => {
    const from = pick("2026-11-03");
    const result = instancesInRange(series, [], from, Temporal.PlainDate.from("2026-11-05"), TZ);
    expect(days(result)).toEqual(["2026-11-03", "2026-11-04", "2026-11-05"]);
  });

  it("終わりの日が最初の回より前なら、最初の回だけ", () => {
    const from = pick("2026-11-03");
    const result = instancesInRange(series, [], from, Temporal.PlainDate.from("2026-11-01"), TZ);
    expect(days(result)).toEqual(["2026-11-03"]);
  });

  it("すでにキャンセル済みの回は数えない", () => {
    const cancelled: InstanceOverride = {
      id: instanceId(SERIES_ID, pick("2026-11-04").originalStartMs!),
      seriesId: SERIES_ID,
      originalStartMs: pick("2026-11-04").originalStartMs!,
      patch: null,
    };
    const from = pick("2026-11-03", [cancelled]);
    const result = instancesInRange(series, [cancelled], from, Temporal.PlainDate.from("2026-11-06"), TZ);
    expect(days(result)).toEqual(["2026-11-03", "2026-11-05", "2026-11-06"]);
  });

  it("別のシリーズの例外は混ざらない", () => {
    const other: InstanceOverride = {
      id: "other:1",
      seriesId: "g:acc:cal:other",
      originalStartMs: pick("2026-11-04").originalStartMs!,
      patch: null,
    };
    const from = pick("2026-11-03");
    const result = instancesInRange(series, [other], from, Temporal.PlainDate.from("2026-11-05"), TZ);
    expect(days(result)).toEqual(["2026-11-03", "2026-11-04", "2026-11-05"]);
  });
});

describe("buildSeriesDeleteRequest", () => {
  it("親の event id を宛先にする(インスタンスの接尾辞は付かない)", () => {
    const req = buildSeriesDeleteRequest(pick("2026-11-03"));
    expect(req).toMatchObject({ accountId: "acc", calendarId: "cal", eventId: "evt1" });
  });

  it("Google 以外・繰り返しでない予定は null", () => {
    expect(buildSeriesDeleteRequest({ ...pick("2026-11-03"), source: "local" })).toBeNull();
    expect(buildSeriesDeleteRequest({ ...pick("2026-11-03"), seriesId: null })).toBeNull();
  });
});

describe("isRecurringGoogleOccurrence", () => {
  it("繰り返しの回だけ true", () => {
    expect(isRecurringGoogleOccurrence(pick("2026-11-03"))).toBe(true);
    expect(isRecurringGoogleOccurrence({ ...pick("2026-11-03"), seriesId: null })).toBe(false);
    expect(isRecurringGoogleOccurrence({ ...pick("2026-11-03"), source: "local" })).toBe(false);
  });
});
