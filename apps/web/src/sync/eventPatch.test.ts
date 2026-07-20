import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Temporal } from "@js-temporal/polyfill";
import type { Occurrence } from "../model/types";
import {
  buildEventDeleteRequest,
  buildEventPatchRequest,
  rawGoogleEventId,
  seriesInstanceEventId,
  utcBasicFromEpochMs,
} from "./eventPatch";

function zms(iso: string, timeZone: string): number {
  return Temporal.PlainDateTime.from(iso).toZonedDateTime(timeZone).epochMilliseconds;
}

function baseOccurrence(overrides: Partial<Occurrence> = {}): Occurrence {
  return {
    id: "g:acc-1:cal-1:evt-1",
    seriesId: null,
    title: "Test Event",
    startMs: zms("2026-07-20T10:00", "Asia/Tokyo"),
    endMs: zms("2026-07-20T11:00", "Asia/Tokyo"),
    color: "#3b82f6",
    source: "google",
    accountId: "acc-1",
    calendarId: "cal-1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rawGoogleEventId", () => {
  it("g:<accountId>:<calendarId>:<eventId> から eventId を取り出す", () => {
    expect(rawGoogleEventId("g:acc-1:cal-1:evt-1")).toBe("evt-1");
  });

  it("eventId 自体にコロンが含まれていても安全に復元する", () => {
    expect(rawGoogleEventId("g:acc-1:cal-1:evt:with:colons")).toBe("evt:with:colons");
  });

  it("g: プレフィックスでない、またはセグメント不足なら throw する", () => {
    expect(() => rawGoogleEventId("local-evt-1")).toThrow();
    expect(() => rawGoogleEventId("g:acc-1:evt-1")).toThrow();
  });
});

describe("utcBasicFromEpochMs", () => {
  it("epoch ms を UTC の RFC5545 basic 形式に変換する", () => {
    // 2026-07-20T10:00:00+09:00 == 2026-07-20T01:00:00Z
    const ms = zms("2026-07-20T10:00:00", "Asia/Tokyo");
    expect(utcBasicFromEpochMs(ms)).toBe("20260720T010000Z");
  });

  it("一桁の月・日・時・分・秒を 0 埋めする", () => {
    const ms = Temporal.ZonedDateTime.from({
      timeZone: "UTC",
      year: 2026,
      month: 1,
      day: 2,
      hour: 3,
      minute: 4,
      second: 5,
    }).epochMilliseconds;
    expect(utcBasicFromEpochMs(ms)).toBe("20260102T030405Z");
  });
});

describe("seriesInstanceEventId", () => {
  it('親の生 event id + "_" + originalStartMs の UTC basic 形式を組み立てる', () => {
    const seriesId = "g:acc-1:cal-1:series-evt";
    const originalStartMs = zms("2026-07-20T10:00:00", "Asia/Tokyo");
    expect(seriesInstanceEventId(seriesId, originalStartMs)).toBe("series-evt_20260720T010000Z");
  });
});

describe("buildEventPatchRequest", () => {
  it("単発の google occurrence から EventPatchRequest を組み立てる", () => {
    const occ = baseOccurrence();
    const req = buildEventPatchRequest(occ, "Asia/Tokyo");
    expect(req).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      eventId: "evt-1",
      startMs: occ.startMs,
      endMs: occ.endMs,
      timeZone: "Asia/Tokyo",
    });
  });

  it("シリーズ由来の occurrence はインスタンス ID を組み立てる", () => {
    const originalStartMs = zms("2026-07-20T10:00:00", "Asia/Tokyo");
    const occ = baseOccurrence({
      id: `g:acc-1:cal-1:series-evt:${originalStartMs}`,
      seriesId: "g:acc-1:cal-1:series-evt",
      originalStartMs,
      // ドラッグで動かした後の新しい時刻
      startMs: zms("2026-07-20T14:00", "Asia/Tokyo"),
      endMs: zms("2026-07-20T15:00", "Asia/Tokyo"),
    });
    const req = buildEventPatchRequest(occ, "Asia/Tokyo");
    expect(req).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      eventId: "series-evt_20260720T010000Z",
      startMs: occ.startMs,
      endMs: occ.endMs,
      timeZone: "Asia/Tokyo",
    });
  });

  it('source !== "google" なら null', () => {
    const occ = baseOccurrence({ source: "local" });
    expect(buildEventPatchRequest(occ, "Asia/Tokyo")).toBeNull();
  });

  it("accountId または calendarId が欠けていれば null", () => {
    const occ = baseOccurrence({ accountId: undefined });
    expect(buildEventPatchRequest(occ, "Asia/Tokyo")).toBeNull();
  });

  it("id のパースに失敗したら null (console.error はするが throw しない)", () => {
    const occ = baseOccurrence({ id: "not-a-google-id" });
    expect(buildEventPatchRequest(occ, "Asia/Tokyo")).toBeNull();
  });
});

describe("buildEventDeleteRequest", () => {
  it("単発の google occurrence から EventDeleteRequest を組み立てる", () => {
    const occ = baseOccurrence();
    expect(buildEventDeleteRequest(occ)).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      eventId: "evt-1",
    });
  });

  it("シリーズ由来の occurrence はインスタンス ID を組み立てる", () => {
    const originalStartMs = zms("2026-07-20T10:00:00", "Asia/Tokyo");
    const occ = baseOccurrence({
      id: `g:acc-1:cal-1:series-evt:${originalStartMs}`,
      seriesId: "g:acc-1:cal-1:series-evt",
      originalStartMs,
    });
    expect(buildEventDeleteRequest(occ)).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      eventId: "series-evt_20260720T010000Z",
    });
  });

  it('source !== "google" なら null', () => {
    const occ = baseOccurrence({ source: "local" });
    expect(buildEventDeleteRequest(occ)).toBeNull();
  });

  it("accountId または calendarId が欠けていれば null", () => {
    const occ = baseOccurrence({ calendarId: undefined });
    expect(buildEventDeleteRequest(occ)).toBeNull();
  });

  it("id のパースに失敗したら null (console.error はするが throw しない)", () => {
    const occ = baseOccurrence({ id: "not-a-google-id" });
    expect(buildEventDeleteRequest(occ)).toBeNull();
  });
});
