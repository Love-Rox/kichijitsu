import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vite-plus/test";
import {
  MAX_SECONDARY_TIME_ZONES,
  hourLabelsIn,
  isValidTimeZone,
  normalizeSecondaryTimeZones,
  parseSecondaryTimeZones,
  timeZoneCity,
  timeZoneOffsetLabel,
} from "./secondaryTimeZones";

const day = Temporal.PlainDate.from("2026-01-15"); // 冬(夏時間なし)

describe("isValidTimeZone", () => {
  it("IANA の ID だけを通す", () => {
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});

describe("normalizeSecondaryTimeZones", () => {
  it("壊れた値・使えない ID・重複・基準と同じもの・上限超過を落とす", () => {
    expect(normalizeSecondaryTimeZones("x")).toEqual([]);
    expect(
      normalizeSecondaryTimeZones(
        ["Asia/Tokyo", "Nope/Zone", "Asia/Tokyo", "Europe/London", "America/New_York"],
        "Asia/Tokyo",
      ),
    ).toEqual(["Europe/London", "America/New_York"]);
    expect(
      normalizeSecondaryTimeZones(["Europe/London", "America/New_York", "Asia/Seoul"]),
    ).toHaveLength(MAX_SECONDARY_TIME_ZONES);
  });

  it("JSON として読めない保存値は空", () => {
    expect(parseSecondaryTimeZones("{not json")).toEqual([]);
    expect(parseSecondaryTimeZones('["Europe/London"]')).toEqual(["Europe/London"]);
  });
});

describe("timeZoneCity / timeZoneOffsetLabel", () => {
  it("都市名とずれを、短く書く", () => {
    expect(timeZoneCity("America/New_York")).toBe("New York");
    expect(timeZoneCity("UTC")).toBe("UTC");
    expect(timeZoneOffsetLabel("Asia/Tokyo", day)).toBe("GMT+9");
    expect(timeZoneOffsetLabel("America/New_York", day)).toBe("GMT-5");
    expect(timeZoneOffsetLabel("Asia/Kolkata", day)).toBe("GMT+5:30");
  });
});

describe("hourLabelsIn", () => {
  it("東京の 0〜23 時を、ニューヨーク(冬は 14 時間遅れ)の時刻にする", () => {
    const labels = hourLabelsIn("America/New_York", "Asia/Tokyo", day);
    expect(labels).toHaveLength(24);
    expect(labels[0]).toBe("10:00"); // 東京 0:00 = 前日 10:00
    expect(labels[9]).toBe("19:00");
    expect(labels[14]).toBe("0:00");
  });

  it("30 分ずれる地域は、分も出す", () => {
    expect(hourLabelsIn("Asia/Kolkata", "Asia/Tokyo", day)[9]).toBe("5:30");
  });

  it("夏時間: 基準の側の壁時計が起点なので、その日の h 時に必ず対応する", () => {
    const summer = Temporal.PlainDate.from("2026-07-15");
    expect(hourLabelsIn("America/New_York", "Asia/Tokyo", summer)[9]).toBe("20:00"); // 夏は 13 時間遅れ
  });
});
