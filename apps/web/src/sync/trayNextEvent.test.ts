import { describe, expect, it } from "vite-plus/test";
import type { Occurrence } from "../model/types";
import {
  buildTrayStatus,
  getTrayNextEventEnabled,
  pickNextEvent,
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
