import { describe, expect, it } from "vite-plus/test";
import type { Occurrence } from "../model/types";
import {
  buildTrayInfo,
  buildTrayStatus,
  getTrayNextEventEnabled,
  listTodayEvents,
  pickNextEvent,
  pickNextMeeting,
  relativeLabel,
} from "./trayNextEvent";

const MIN = 60_000;
const now = Date.UTC(2026, 10, 7, 1, 0); // 10:00 JST
function ev(partial: Partial<Occurrence> & { startMs: number; endMs: number }): Occurrence {
  return {
    id: String(partial.startMs),
    title: "定例",
    color: "#000",
    source: "google",
    ...partial,
  } as Occurrence;
}

describe("pickNextEvent", () => {
  it("終わっていない予定のうち、開始が最も早いものを選ぶ", () => {
    const a = ev({ startMs: now + 90 * MIN, endMs: now + 120 * MIN, title: "A" });
    const b = ev({ startMs: now + 30 * MIN, endMs: now + 60 * MIN, title: "B" });
    expect(pickNextEvent([a, b], now)?.title).toBe("B");
  });
  it("進行中の予定は先に来る。終わった予定は選ばない", () => {
    const done = ev({ startMs: now - 60 * MIN, endMs: now - 1, title: "done" });
    const running = ev({ startMs: now - 10 * MIN, endMs: now + 20 * MIN, title: "running" });
    const later = ev({ startMs: now + 10 * MIN, endMs: now + 30 * MIN, title: "later" });
    expect(pickNextEvent([done, later, running], now)?.title).toBe("running");
  });
  it("不在・勤務場所・ミラー・辞退は対象外", () => {
    const base = { startMs: now + 10 * MIN, endMs: now + 20 * MIN };
    expect(pickNextEvent([ev({ ...base, isOutOfOffice: true })], now)).toBeNull();
    expect(pickNextEvent([ev({ ...base, isWorkingLocation: true })], now)).toBeNull();
    expect(pickNextEvent([ev({ ...base, isMirror: true })], now)).toBeNull();
    expect(pickNextEvent([ev({ ...base, responseStatus: "declined" })], now)).toBeNull();
  });
});

describe("relativeLabel", () => {
  it("分・時間・進行中", () => {
    expect(relativeLabel(now + 15 * MIN, now)).toBe("あと15分");
    expect(relativeLabel(now + 120 * MIN, now)).toBe("あと2時間");
    expect(relativeLabel(now + 150 * MIN, now)).toBe("あと2時間30分");
    expect(relativeLabel(now - MIN, now)).toBe("進行中");
  });
});

describe("buildTrayStatus", () => {
  it("1 時間より先は時刻、以内は あと◯分", () => {
    const far = ev({ startMs: now + 90 * MIN, endMs: now + 120 * MIN });
    expect(buildTrayStatus(far, now, "Asia/Tokyo").title).toBe("11:30 定例");
    const near = ev({ startMs: now + 15 * MIN, endMs: now + 45 * MIN });
    expect(buildTrayStatus(near, now, "Asia/Tokyo").title).toBe("定例 あと15分");
  });
  it("長いタイトルは切り詰める。予定が無ければ空", () => {
    const long = ev({ startMs: now + 90 * MIN, endMs: now + 120 * MIN, title: "あ".repeat(30) });
    expect([...buildTrayStatus(long, now, "Asia/Tokyo").title.replace("11:30 ", "")]).toHaveLength(18);
    expect(buildTrayStatus(null, now, "Asia/Tokyo").title).toBe("");
  });
});

describe("getTrayNextEventEnabled", () => {
  const store = (v: string | null) => ({ getItem: () => v, setItem: () => {}, removeItem: () => {} });
  it("既定はオン。off だけがオフ", () => {
    expect(getTrayNextEventEnabled(store(null))).toBe(true);
    expect(getTrayNextEventEnabled(store("off"))).toBe(false);
    expect(getTrayNextEventEnabled(store("zzz"))).toBe(true);
  });
});

describe("pickNextMeeting", () => {
  it("会議の URL を持つ、最も早い予定を選ぶ(URL の無い予定は飛ばす)", () => {
    const noUrl = ev({ startMs: now + 10 * MIN, endMs: now + 40 * MIN, title: "URL なし" });
    const meet = ev({
      startMs: now + 30 * MIN,
      endMs: now + 60 * MIN,
      title: "定例",
      conferenceUrl: "https://meet.google.com/abc",
    });
    const later = ev({
      startMs: now + 90 * MIN,
      endMs: now + 120 * MIN,
      conferenceUrl: "https://zoom.us/j/1",
    });
    expect(pickNextMeeting([later, noUrl, meet], now)?.event.title).toBe("定例");
    expect(pickNextMeeting([later, noUrl, meet], now)?.url).toBe("https://meet.google.com/abc");
  });
  it("場所に会議 URL が入っている予定(Zoom など)も対象。進行中の会議も対象", () => {
    const loc = ev({ startMs: now - 10 * MIN, endMs: now + 20 * MIN, location: "https://zoom.us/j/123" });
    expect(pickNextMeeting([loc], now)?.url).toBe("https://zoom.us/j/123");
  });
  it("http/https 以外の URL・辞退した予定・終わった予定は対象外", () => {
    const base = { startMs: now + 10 * MIN, endMs: now + 40 * MIN };
    expect(pickNextMeeting([ev({ ...base, conferenceUrl: "javascript:alert(1)" })], now)).toBeNull();
    expect(pickNextMeeting([ev({ ...base, conferenceUrl: "tel:+81000" })], now)).toBeNull();
    expect(
      pickNextMeeting([ev({ ...base, conferenceUrl: "https://meet.google.com/a", responseStatus: "declined" })], now),
    ).toBeNull();
    expect(
      pickNextMeeting(
        [ev({ startMs: now - 60 * MIN, endMs: now - 1, conferenceUrl: "https://meet.google.com/a" })],
        now,
      ),
    ).toBeNull();
  });
});

describe("listTodayEvents", () => {
  it("今日(日本時間)のこれからの予定を、開始順に並べる。明日以降と終わった予定は含まない", () => {
    const past = ev({ startMs: now - 60 * MIN, endMs: now - 1, title: "past" });
    const a = ev({ startMs: now + 30 * MIN, endMs: now + 60 * MIN, title: "a" });
    const running = ev({ startMs: now - 10 * MIN, endMs: now + 20 * MIN, title: "running" });
    // now = 10:00 JST。翌日 0:00 JST = 15:00 UTC
    const tomorrow = ev({ startMs: Date.UTC(2026, 10, 7, 15, 30), endMs: Date.UTC(2026, 10, 7, 16, 30), title: "tomorrow" });
    const got = listTodayEvents([tomorrow, a, past, running], now, "Asia/Tokyo");
    expect(got.map((o) => o.title)).toEqual(["running", "a"]);
  });
  it("8 件までに絞る", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      ev({ startMs: now + (i + 1) * 10 * MIN, endMs: now + (i + 1) * 10 * MIN + 5 * MIN, title: `e${i}` }),
    );
    expect(listTodayEvents(many, now, "Asia/Tokyo")).toHaveLength(8);
  });
});

describe("buildTrayInfo", () => {
  it("次の予定・次の会議・今日の予定を、まとめて返す", () => {
    const meet = ev({
      startMs: now + 90 * MIN,
      endMs: now + 120 * MIN,
      title: "定例",
      conferenceUrl: "https://meet.google.com/abc",
    });
    const info = buildTrayInfo([meet], now, "Asia/Tokyo");
    expect(info.title).toBe("11:30 定例");
    expect(info.joinLabel).toBe("11:30 定例");
    expect(info.joinUrl).toBe("https://meet.google.com/abc");
    expect(info.eventLabels).toEqual(["11:30 定例"]);
    expect(info.eventStarts).toEqual([meet.startMs]);
  });
  it("予定が無ければ、すべて空", () => {
    const info = buildTrayInfo([], now, "Asia/Tokyo");
    expect(info).toEqual({ title: "", tooltip: "kichijitsu", eventLabels: [], eventStarts: [] });
  });
});
