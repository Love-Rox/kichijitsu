import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Temporal } from "@js-temporal/polyfill";
import type { GoogleEventDTO } from "@kichijitsu/shared";
import { mapGoogleEvents, type MapGoogleContext } from "./mapGoogle";
import { instanceId } from "../model/series";

function zms(iso: string, timeZone: string): number {
  return Temporal.PlainDateTime.from(iso).toZonedDateTime(timeZone).epochMilliseconds;
}

function baseEvent(overrides: Partial<GoogleEventDTO> = {}): GoogleEventDTO {
  return {
    id: "evt-1",
    status: "confirmed",
    summary: "Test Event",
    start: { dateTime: "2026-07-20T10:00:00+09:00", timeZone: "Asia/Tokyo" },
    end: { dateTime: "2026-07-20T11:00:00+09:00", timeZone: "Asia/Tokyo" },
    ...overrides,
  };
}

/** テスト全体の既定コンテキスト。マルチアカウント対応の id スコープ検証は専用の describe で行う */
const ctx: MapGoogleContext = { accountId: "acc-1", calendarId: "cal-1" };

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mapGoogleEvents", () => {
  it("繰り返しの親イベントを EventSeries に変換し、TZID付き EXDATE をパースする", () => {
    const event = baseEvent({
      id: "series-evt",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE", "EXDATE;TZID=Asia/Tokyo:20260720T100000"],
    });

    const result = mapGoogleEvents([event], ctx);

    expect(result.series).toHaveLength(1);
    const series = result.series[0];
    expect(series.id).toBe("g:acc-1:cal-1:series-evt");
    expect(series.accountId).toBe("acc-1");
    expect(series.calendarId).toBe("cal-1");
    expect(series.dtstartIso).toBe("2026-07-20T10:00");
    expect(series.timeZone).toBe("Asia/Tokyo");
    expect(series.durationMin).toBe(60);
    expect(series.rrule).toBe("FREQ=WEEKLY;BYDAY=MO,WE");
    expect(series.exdatesMs).toEqual([zms("2026-07-20T10:00", "Asia/Tokyo")]);
    expect(series.source).toBe("google");
    expect(result.overrides).toHaveLength(0);
    expect(result.singles).toHaveLength(0);
  });

  it("UTC (Z サフィックス) の EXDATE もパースする", () => {
    const event = baseEvent({
      id: "series-utc",
      recurrence: ["RRULE:FREQ=DAILY", "EXDATE:20260720T010000Z"],
    });

    const result = mapGoogleEvents([event], ctx);

    expect(result.series[0].exdatesMs).toEqual([
      Temporal.ZonedDateTime.from({
        timeZone: "UTC",
        year: 2026,
        month: 7,
        day: 20,
        hour: 1,
        minute: 0,
        second: 0,
      }).toInstant().epochMilliseconds,
    ]);
  });

  it("カンマ区切りの複数 EXDATE 値をパースする", () => {
    const event = baseEvent({
      id: "series-multi",
      recurrence: ["RRULE:FREQ=DAILY", "EXDATE;TZID=Asia/Tokyo:20260720T100000,20260722T100000"],
    });

    const result = mapGoogleEvents([event], ctx);

    expect(result.series[0].exdatesMs).toEqual([
      zms("2026-07-20T10:00", "Asia/Tokyo"),
      zms("2026-07-22T10:00", "Asia/Tokyo"),
    ]);
  });

  it("cancelled な例外インスタンスを patch:null の InstanceOverride に変換する", () => {
    const event = baseEvent({
      id: "exception-1",
      status: "cancelled",
      recurringEventId: "series-evt",
      originalStartTime: { dateTime: "2026-07-27T10:00:00+09:00", timeZone: "Asia/Tokyo" },
      start: undefined,
      end: undefined,
    });

    const result = mapGoogleEvents([event], ctx);

    expect(result.overrides).toHaveLength(1);
    const override = result.overrides[0];
    const originalStartMs = zms("2026-07-27T10:00", "Asia/Tokyo");
    expect(override.seriesId).toBe("g:acc-1:cal-1:series-evt");
    expect(override.originalStartMs).toBe(originalStartMs);
    expect(override.id).toBe(instanceId("g:acc-1:cal-1:series-evt", originalStartMs));
    expect(override.patch).toBeNull();
  });

  it("時刻変更された例外インスタンスを patch 付き InstanceOverride に変換する", () => {
    const event = baseEvent({
      id: "exception-2",
      recurringEventId: "series-evt",
      summary: "Rescheduled",
      originalStartTime: { dateTime: "2026-07-27T10:00:00+09:00", timeZone: "Asia/Tokyo" },
      start: { dateTime: "2026-07-27T14:00:00+09:00", timeZone: "Asia/Tokyo" },
      end: { dateTime: "2026-07-27T15:00:00+09:00", timeZone: "Asia/Tokyo" },
    });

    const result = mapGoogleEvents([event], ctx);

    expect(result.overrides).toHaveLength(1);
    const override = result.overrides[0];
    expect(override.patch).toEqual({
      title: "Rescheduled",
      startMs: zms("2026-07-27T14:00", "Asia/Tokyo"),
      endMs: zms("2026-07-27T15:00", "Asia/Tokyo"),
    });
  });

  it("単発イベントを Occurrence に変換する", () => {
    const event = baseEvent({
      id: "single-1",
      summary: "Lunch",
      colorId: "5",
      htmlLink: "https://calendar.google.com/event?eid=abc",
    });

    const result = mapGoogleEvents([event], ctx);

    expect(result.singles).toHaveLength(1);
    const occ = result.singles[0];
    expect(occ.id).toBe("g:acc-1:cal-1:single-1");
    expect(occ.seriesId).toBeNull();
    expect(occ.title).toBe("Lunch");
    expect(occ.startMs).toBe(zms("2026-07-20T10:00", "Asia/Tokyo"));
    expect(occ.endMs).toBe(zms("2026-07-20T11:00", "Asia/Tokyo"));
    expect(occ.color).toBe("#f6bf26");
    expect(occ.source).toBe("google");
    expect(occ.accountId).toBe("acc-1");
    expect(occ.calendarId).toBe("cal-1");
    expect(occ.link).toEqual({ url: "https://calendar.google.com/event?eid=abc" });
  });

  it("cancelled な単発イベントは deletedSingleIds に入る", () => {
    const event = baseEvent({ id: "single-cancelled", status: "cancelled" });

    const result = mapGoogleEvents([event], ctx);

    expect(result.singles).toHaveLength(0);
    expect(result.deletedSingleIds).toEqual(["g:acc-1:cal-1:single-cancelled"]);
  });

  it("終日の単発イベント (start.date のみ) は AllDayOccurrence に変換する (end.date は排他的→inclusive に正規化)", () => {
    const event = baseEvent({
      id: "allday-1",
      summary: "海の日",
      colorId: "11",
      start: { date: "2026-07-20" },
      end: { date: "2026-07-21" }, // 排他的: 実質 7/20 のみの1日イベント
    });

    const result = mapGoogleEvents([event], ctx);

    expect(result.singles).toHaveLength(0);
    expect(result.series).toHaveLength(0);
    expect(result.allDays).toHaveLength(1);
    const allDay = result.allDays[0];
    expect(allDay.id).toBe("g:acc-1:cal-1:allday-1");
    expect(allDay.seriesId).toBeNull();
    expect(allDay.title).toBe("海の日");
    expect(allDay.startDate).toBe("2026-07-20");
    expect(allDay.endDate).toBe("2026-07-20"); // inclusive 化: 排他的な7/21ではなく7/20
    expect(allDay.color).toBe("#d50000");
    expect(allDay.source).toBe("google");
    expect(allDay.accountId).toBe("acc-1");
    expect(allDay.calendarId).toBe("cal-1");
    expect(result.skippedAllDayRecurring).toBe(0);
  });

  it("複数日にまたがる終日イベントの end.date を inclusive な endDate に正規化する", () => {
    const event = baseEvent({
      id: "allday-multiday",
      start: { date: "2026-08-08" },
      end: { date: "2026-08-11" }, // 排他的: 8/8, 8/9, 8/10 の3日間 (8/11 は含まない)
    });

    const result = mapGoogleEvents([event], ctx);

    expect(result.allDays).toHaveLength(1);
    expect(result.allDays[0].startDate).toBe("2026-08-08");
    expect(result.allDays[0].endDate).toBe("2026-08-10");
  });

  it("cancelled な終日イベントは deletedAllDayIds に入る", () => {
    const event = baseEvent({
      id: "allday-cancelled",
      status: "cancelled",
      start: { date: "2026-07-20" },
      end: { date: "2026-07-21" },
    });

    const result = mapGoogleEvents([event], ctx);

    expect(result.allDays).toHaveLength(0);
    expect(result.deletedAllDayIds).toEqual(["g:acc-1:cal-1:allday-cancelled"]);
  });

  it("終日の繰り返し親 (recurrence あり + start.date) は skippedAllDayRecurring をインクリメントしてスキップする", () => {
    const event = baseEvent({
      id: "allday-series",
      start: { date: "2026-07-20" },
      end: { date: "2026-07-21" },
      recurrence: ["RRULE:FREQ=YEARLY"],
    });

    const result = mapGoogleEvents([event], ctx);

    expect(result.series).toHaveLength(0);
    expect(result.allDays).toHaveLength(0);
    expect(result.skippedAllDayRecurring).toBe(1);
    expect(console.info).toHaveBeenCalled();
  });

  it("終日の繰り返し例外インスタンス (recurringEventId + start.date) も skippedAllDayRecurring に数える", () => {
    const event = baseEvent({
      id: "allday-exception",
      recurringEventId: "allday-series",
      start: { date: "2026-07-27" },
      end: { date: "2026-07-28" },
      originalStartTime: { date: "2026-07-20" },
    });

    const result = mapGoogleEvents([event], ctx);

    expect(result.overrides).toHaveLength(0);
    expect(result.allDays).toHaveLength(0);
    expect(result.skippedAllDayRecurring).toBe(1);
  });

  it("未対応の recurrence 行 (RDATE 等) は行単位でスキップし、RRULE は活かす", () => {
    const event = baseEvent({
      id: "series-rdate",
      recurrence: ["RRULE:FREQ=DAILY", "RDATE:20260801T100000Z"],
    });

    const result = mapGoogleEvents([event], ctx);

    expect(result.series).toHaveLength(1);
    expect(result.series[0].rrule).toBe("FREQ=DAILY");
    expect(console.warn).toHaveBeenCalled();
  });

  it("RRULE 行が無い recurrence は series ごとスキップする (warn する)", () => {
    const event = baseEvent({
      id: "series-no-rrule",
      recurrence: ["EXDATE;TZID=Asia/Tokyo:20260720T100000"],
    });

    const result = mapGoogleEvents([event], ctx);

    expect(result.series).toHaveLength(0);
    expect(console.warn).toHaveBeenCalled();
  });

  it("壊れた EXDATE 値は行単位でスキップし、シリーズ自体は変換を続ける", () => {
    const event = baseEvent({
      id: "series-bad-exdate",
      recurrence: ["RRULE:FREQ=DAILY", "EXDATE;TZID=Asia/Tokyo:not-a-date"],
    });

    const result = mapGoogleEvents([event], ctx);

    expect(result.series).toHaveLength(1);
    expect(result.series[0].exdatesMs).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("1件の変換失敗は他のイベントを巻き込まない", () => {
    const broken = baseEvent({
      id: "broken-exception",
      recurringEventId: "series-evt",
      originalStartTime: undefined,
    });
    const healthy = baseEvent({ id: "healthy-single" });

    const result = mapGoogleEvents([broken, healthy], ctx);

    expect(result.overrides).toHaveLength(0);
    expect(result.singles).toHaveLength(1);
    expect(result.singles[0].id).toBe("g:acc-1:cal-1:healthy-single");
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("mapGoogleEvents: id スコープ (マルチアカウント/マルチカレンダー)", () => {
  it("同じ event.id でも (accountId, calendarId) が違えば別 occurrence id になる(共有予定の衝突対策)", () => {
    const event = baseEvent({ id: "shared-evt" });

    const resultA = mapGoogleEvents([event], { accountId: "acc-1", calendarId: "cal-1" });
    const resultB = mapGoogleEvents([event], { accountId: "acc-1", calendarId: "cal-2" });
    const resultC = mapGoogleEvents([event], { accountId: "acc-2", calendarId: "cal-1" });

    expect(resultA.singles[0].id).toBe("g:acc-1:cal-1:shared-evt");
    expect(resultB.singles[0].id).toBe("g:acc-1:cal-2:shared-evt");
    expect(resultC.singles[0].id).toBe("g:acc-2:cal-1:shared-evt");
    const ids = [resultA, resultB, resultC].map((r) => r.singles[0].id);
    expect(new Set(ids).size).toBe(3);
  });

  it("シリーズの id・override の seriesId も (accountId, calendarId) でスコープされる", () => {
    const series = baseEvent({ id: "series-shared", recurrence: ["RRULE:FREQ=DAILY"] });
    const exception = baseEvent({
      id: "exception-shared",
      recurringEventId: "series-shared",
      originalStartTime: { dateTime: "2026-07-27T10:00:00+09:00", timeZone: "Asia/Tokyo" },
      start: { dateTime: "2026-07-27T14:00:00+09:00", timeZone: "Asia/Tokyo" },
      end: { dateTime: "2026-07-27T15:00:00+09:00", timeZone: "Asia/Tokyo" },
    });

    const result = mapGoogleEvents([series, exception], {
      accountId: "acc-1",
      calendarId: "cal-2",
    });

    expect(result.series[0].id).toBe("g:acc-1:cal-2:series-shared");
    expect(result.overrides[0].seriesId).toBe("g:acc-1:cal-2:series-shared");
  });
});

describe("mapGoogleEvents: 色フォールバック", () => {
  it("colorId があれば Google 公式パレットの色を使う(カレンダー色より優先)", () => {
    const event = baseEvent({ id: "colored", colorId: "11" });

    const result = mapGoogleEvents([event], { ...ctx, defaultColor: "#123456" });

    expect(result.singles[0].color).toBe("#d50000"); // colorId '11' = Tomato
  });

  it("colorId が無ければカレンダーの backgroundColor (defaultColor) を使う", () => {
    const event = baseEvent({ id: "no-color-id" });

    const result = mapGoogleEvents([event], { ...ctx, defaultColor: "#123456" });

    expect(result.singles[0].color).toBe("#123456");
  });

  it("colorId が未知の値でもカレンダー色へフォールバックする(決め打ちの既定色にはしない)", () => {
    const event = baseEvent({ id: "unknown-color-id", colorId: "999" });

    const result = mapGoogleEvents([event], { ...ctx, defaultColor: "#123456" });

    expect(result.singles[0].color).toBe("#123456");
  });

  it("colorId も defaultColor も無ければ最終フォールバック色になる", () => {
    const event = baseEvent({ id: "no-color-at-all" });

    const result = mapGoogleEvents([event], ctx); // defaultColor 未指定

    expect(result.singles[0].color).toBe("#3b82f6");
  });
});

describe("mapGoogleEvents: hasCustomColor (表示色バグ修正 2026-07-20)", () => {
  it("colorId が Google 公式パレットに実際にマップされた単発イベントは hasCustomColor: true", () => {
    const event = baseEvent({ id: "single-colored", colorId: "11" });

    const result = mapGoogleEvents([event], { ...ctx, defaultColor: "#123456" });

    expect(result.singles[0].hasCustomColor).toBe(true);
  });

  it("colorId が無い単発イベントは hasCustomColor: false(ctx.defaultColor 未定義でも表示側で再解決させるため)", () => {
    const event = baseEvent({ id: "single-no-color-id" });

    const result = mapGoogleEvents([event], ctx); // defaultColor 未指定 → DEFAULT_COLOR 焼き込み

    expect(result.singles[0].hasCustomColor).toBe(false);
  });

  it("colorId が未知の値の単発イベントも hasCustomColor: false(実際には個別色を使えていないため)", () => {
    const event = baseEvent({ id: "single-unknown-color-id", colorId: "999" });

    const result = mapGoogleEvents([event], { ...ctx, defaultColor: "#123456" });

    expect(result.singles[0].hasCustomColor).toBe(false);
  });

  it("colorId ありのシリーズ・終日イベントも hasCustomColor: true になる", () => {
    const series = baseEvent({
      id: "series-colored",
      colorId: "5",
      recurrence: ["RRULE:FREQ=WEEKLY"],
    });
    const allDay = baseEvent({
      id: "allday-colored",
      colorId: "2",
      start: { date: "2026-07-20" },
      end: { date: "2026-07-21" },
    });

    const result = mapGoogleEvents([series, allDay], ctx);

    expect(result.series[0].hasCustomColor).toBe(true);
    expect(result.allDays[0].hasCustomColor).toBe(true);
  });

  it("colorId 無しのシリーズ・終日イベントは hasCustomColor: false", () => {
    const series = baseEvent({ id: "series-no-color", recurrence: ["RRULE:FREQ=WEEKLY"] });
    const allDay = baseEvent({
      id: "allday-no-color",
      start: { date: "2026-07-20" },
      end: { date: "2026-07-21" },
    });

    const result = mapGoogleEvents([series, allDay], { ...ctx, defaultColor: "#123456" });

    expect(result.series[0].hasCustomColor).toBe(false);
    expect(result.allDays[0].hasCustomColor).toBe(false);
  });
});

describe("mapGoogleEvents: location / description の取り込み", () => {
  it("単発イベント・シリーズの location/description を写す", () => {
    const single = baseEvent({
      id: "single-with-location",
      location: "会議室A",
      description: "<p>資料は事前に共有します</p>",
    });
    const series = baseEvent({
      id: "series-with-location",
      recurrence: ["RRULE:FREQ=WEEKLY"],
      location: "オンライン (Google Meet)",
      description: "毎週の定例",
    });

    const result = mapGoogleEvents([single, series], ctx);

    expect(result.singles[0].location).toBe("会議室A");
    expect(result.singles[0].description).toBe("<p>資料は事前に共有します</p>");
    expect(result.series[0].location).toBe("オンライン (Google Meet)");
    expect(result.series[0].description).toBe("毎週の定例");
  });

  it("location/description が無いイベントは undefined のまま。例外インスタンスは指定があるときだけ patch に入る", () => {
    const plain = baseEvent({ id: "plain-single" });
    const exceptionWithLocation = baseEvent({
      id: "exception-with-location",
      recurringEventId: "series-evt",
      originalStartTime: { dateTime: "2026-07-27T10:00:00+09:00", timeZone: "Asia/Tokyo" },
      start: { dateTime: "2026-07-27T14:00:00+09:00", timeZone: "Asia/Tokyo" },
      end: { dateTime: "2026-07-27T15:00:00+09:00", timeZone: "Asia/Tokyo" },
      location: "会議室B",
    });
    const exceptionWithoutLocation = baseEvent({
      id: "exception-without-location",
      recurringEventId: "series-evt",
      originalStartTime: { dateTime: "2026-08-03T10:00:00+09:00", timeZone: "Asia/Tokyo" },
      start: { dateTime: "2026-08-03T14:00:00+09:00", timeZone: "Asia/Tokyo" },
      end: { dateTime: "2026-08-03T15:00:00+09:00", timeZone: "Asia/Tokyo" },
    });

    const result = mapGoogleEvents([plain, exceptionWithLocation, exceptionWithoutLocation], ctx);

    expect(result.singles[0].location).toBeUndefined();
    expect(result.singles[0].description).toBeUndefined();
    expect(result.overrides[0].patch).toMatchObject({ location: "会議室B" });
    expect(result.overrides[1].patch).not.toHaveProperty("location");
    expect(result.overrides[1].patch).not.toHaveProperty("description");
  });
});

describe("mapGoogleEvents: iCalUID の取り込み (フェーズ5 重複集約キー)", () => {
  it("単発イベント・シリーズの iCalUID を occurrence/series に写す", () => {
    const single = baseEvent({ id: "single-with-uid", iCalUID: "uid-single@google.com" });
    const series = baseEvent({
      id: "series-with-uid",
      recurrence: ["RRULE:FREQ=WEEKLY"],
      iCalUID: "uid-series@google.com",
    });

    const result = mapGoogleEvents([single, series], ctx);

    expect(result.singles[0].iCalUID).toBe("uid-single@google.com");
    expect(result.series[0].iCalUID).toBe("uid-series@google.com");
  });

  it("iCalUID が無いイベントは undefined のまま", () => {
    const single = baseEvent({ id: "single-without-uid" });

    const result = mapGoogleEvents([single], ctx);

    expect(result.singles[0].iCalUID).toBeUndefined();
  });
});

describe("mapGoogleEvents: isMirror (カレンダーブロック機能の自動生成印、第5段階)", () => {
  it("extendedProperties.private.kichijitsuMirror='1' の単発イベントは isMirror: true になる", () => {
    const mirror = baseEvent({
      id: "mirror-single",
      summary: "予定あり",
      extendedProperties: { private: { kichijitsuMirror: "1" } },
    });

    const result = mapGoogleEvents([mirror], ctx);

    expect(result.singles[0].isMirror).toBe(true);
  });

  it("extendedProperties が無い単発イベントは isMirror: undefined のまま", () => {
    const plain = baseEvent({ id: "plain-single" });

    const result = mapGoogleEvents([plain], ctx);

    expect(result.singles[0].isMirror).toBeUndefined();
  });

  it("kichijitsuMirror が '1' 以外の値の単発イベントは isMirror: undefined のまま", () => {
    const notMirror = baseEvent({
      id: "not-mirror-single",
      extendedProperties: { private: { kichijitsuMirror: "0" } },
    });
    const otherKey = baseEvent({
      id: "other-key-single",
      extendedProperties: { private: { someOtherFlag: "1" } },
    });

    const result = mapGoogleEvents([notMirror, otherKey], ctx);

    expect(result.singles[0].isMirror).toBeUndefined();
    expect(result.singles[1].isMirror).toBeUndefined();
  });

  it("mirror の終日イベント (start.date のみ) も isMirror: true になる", () => {
    const mirrorAllDay = baseEvent({
      id: "mirror-allday",
      summary: "予定あり",
      start: { date: "2026-07-20" },
      end: { date: "2026-07-21" },
      extendedProperties: { private: { kichijitsuMirror: "1" } },
    });

    const result = mapGoogleEvents([mirrorAllDay], ctx);

    expect(result.allDays).toHaveLength(1);
    expect(result.allDays[0].isMirror).toBe(true);
  });

  it("extendedProperties が無い終日イベントは isMirror: undefined のまま", () => {
    const plainAllDay = baseEvent({
      id: "plain-allday",
      start: { date: "2026-07-20" },
      end: { date: "2026-07-21" },
    });

    const result = mapGoogleEvents([plainAllDay], ctx);

    expect(result.allDays[0].isMirror).toBeUndefined();
  });
});

describe("mapGoogleEvents: isOutOfOffice (不在レール表示、2026-07-22)", () => {
  it("eventType==='outOfOffice' の単発イベントは isOutOfOffice: true になる", () => {
    const ooo = baseEvent({ id: "ooo-single", summary: "休暇中", eventType: "outOfOffice" });

    const result = mapGoogleEvents([ooo], ctx);

    expect(result.singles[0].isOutOfOffice).toBe(true);
  });

  it("eventType が無い/'default' の単発イベントは isOutOfOffice: undefined のまま", () => {
    const noType = baseEvent({ id: "no-type-single" });
    const defaultType = baseEvent({ id: "default-type-single", eventType: "default" });

    const result = mapGoogleEvents([noType, defaultType], ctx);

    expect(result.singles[0].isOutOfOffice).toBeUndefined();
    expect(result.singles[1].isOutOfOffice).toBeUndefined();
  });

  it("eventType==='outOfOffice' の終日イベント (start.date のみ) も isOutOfOffice: true になる", () => {
    const oooAllDay = baseEvent({
      id: "ooo-allday",
      summary: "休暇中",
      start: { date: "2026-07-20" },
      end: { date: "2026-07-22" },
      eventType: "outOfOffice",
    });

    const result = mapGoogleEvents([oooAllDay], ctx);

    expect(result.allDays).toHaveLength(1);
    expect(result.allDays[0].isOutOfOffice).toBe(true);
  });

  it("eventType が無い終日イベントは isOutOfOffice: undefined のまま", () => {
    const plainAllDay = baseEvent({
      id: "plain-allday-2",
      start: { date: "2026-07-20" },
      end: { date: "2026-07-21" },
    });

    const result = mapGoogleEvents([plainAllDay], ctx);

    expect(result.allDays[0].isOutOfOffice).toBeUndefined();
  });
});
