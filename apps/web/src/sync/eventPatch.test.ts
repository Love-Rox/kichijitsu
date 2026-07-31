import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Temporal } from "@js-temporal/polyfill";
import type { EventAttendee, Occurrence } from "../model/types";
import {
  buildEventDeleteRequest,
  eventPatchRequestFor,
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

describe("eventPatchRequestFor", () => {
  it("google occurrence + 宛先から EventPatchRequest を組み立てる", () => {
    expect(
      eventPatchRequestFor(
        baseOccurrence(),
        { eventId: "evt-1", startMs: 1, endMs: 2 },
        "Asia/Tokyo",
      ),
    ).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      eventId: "evt-1",
      startMs: 1,
      endMs: 2,
      timeZone: "Asia/Tokyo",
    });
  });

  it("時刻の無い宛先 (内容だけの変更) は startMs/endMs が undefined のまま", () => {
    const req = eventPatchRequestFor(baseOccurrence(), { eventId: "series-1" }, "Asia/Tokyo");
    expect(req?.startMs).toBeUndefined();
    expect(req?.endMs).toBeUndefined();
  });

  it('source !== "google" なら null', () => {
    expect(
      eventPatchRequestFor(baseOccurrence({ source: "local" }), { eventId: "evt-1" }, "Asia/Tokyo"),
    ).toBeNull();
  });

  it("accountId または calendarId が欠けていれば null", () => {
    expect(
      eventPatchRequestFor(
        baseOccurrence({ accountId: undefined }),
        { eventId: "evt-1" },
        "Asia/Tokyo",
      ),
    ).toBeNull();
  });
});

describe("buildEventDeleteRequest", () => {
  it("単発の google occurrence から EventDeleteRequest を組み立てる", () => {
    const occ = baseOccurrence();
    expect(buildEventDeleteRequest(occ)).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      eventId: "evt-1",
      sendUpdates: "externalOnly",
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
      sendUpdates: "externalOnly",
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

/**
 * 削除の sendUpdates (2026-07-31)。判定そのものは sync/guestNotify.ts の resolveSendUpdates
 * (テストは guestNotify.test.ts) で、ここで確かめるのは**削除の body に必ず載ること**と、
 * **更新と同じ結論になること** ―― 削除用に別の規則が生えていないことの歯止め。
 */
describe("buildEventDeleteRequest の sendUpdates", () => {
  const me: EventAttendee = { email: "me@example.com", self: true, organizer: true };
  const guest: EventAttendee = { email: "sato@example.com", responseStatus: "accepted" };

  it("ゲストのいない予定: 選択に関わらず externalOnly (= 2026-07-31 以前と同じ結果)", () => {
    // 知らせる相手がいないので Google 側では**どの値でも結果は同じ**。それでも値は必ず入る
    // ―― 未文書の既定に落とさないのがこの実装の目的
    const alone = baseOccurrence({ isOrganizer: true });
    expect(buildEventDeleteRequest(alone)?.sendUpdates).toBe("externalOnly");
    expect(buildEventDeleteRequest(alone, "all")?.sendUpdates).toBe("externalOnly");
    const selfOnly = baseOccurrence({ isOrganizer: true, attendees: [me] });
    expect(buildEventDeleteRequest(selfOnly, "all")?.sendUpdates).toBe("externalOnly");
  });

  it("ゲスト有り・自分が主催: 選ばれた値をそのまま使う", () => {
    const occ = baseOccurrence({ isOrganizer: true, attendees: [me, guest] });
    expect(buildEventDeleteRequest(occ, "all")?.sendUpdates).toBe("all");
    expect(buildEventDeleteRequest(occ, "externalOnly")?.sendUpdates).toBe("externalOnly");
  });

  it("ゲスト有り・主催者でない: 訊いていないので externalOnly", () => {
    // 招かれた側が予定を消すのは「自分のカレンダーから消す」操作で、他のゲストの予定を
    // 取り消すわけではない ―― 通知を選ばせる場面ではないので choice は無視する
    const occ = baseOccurrence({ isOrganizer: false, attendees: [me, guest] });
    expect(buildEventDeleteRequest(occ, "all")?.sendUpdates).toBe("externalOnly");
  });

  it("ゲスト有り・主催でも、選ばれていなければ externalOnly (訊いていないのに送らない)", () => {
    const occ = baseOccurrence({ isOrganizer: true, attendees: [me, guest] });
    expect(buildEventDeleteRequest(occ)?.sendUpdates).toBe("externalOnly");
  });

  it("どの入力でも none にはならない (外部ゲストに取り消しが届かなくなる値は使わない)", () => {
    const cases: Occurrence[] = [
      baseOccurrence({ isOrganizer: true }),
      baseOccurrence({ isOrganizer: true, attendees: [me, guest] }),
      baseOccurrence({ isOrganizer: false, attendees: [me, guest] }),
    ];
    for (const occ of cases) {
      for (const choice of ["all", "externalOnly", undefined] as const) {
        expect(buildEventDeleteRequest(occ, choice)?.sendUpdates).not.toBe("none");
      }
    }
  });
});
