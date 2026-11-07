import { describe, expect, it } from "vite-plus/test";
import { EVENT_COLORS, colorIdOf } from "../layout/eventColorChoices";
import { buildEventColorRequest, canSetEventColor, type ColorEditSubject } from "./eventColor";

function subject(overrides: Partial<ColorEditSubject> = {}): ColorEditSubject {
  return {
    id: "g:acct-1:cal-1:evt-1",
    source: "google",
    accountId: "acct-1",
    calendarId: "cal-1",
    seriesId: null,
    ...overrides,
  };
}

describe("canSetEventColor", () => {
  it("Google の予定で、書き込み先が分かれば true", () => {
    expect(canSetEventColor(subject())).toBe(true);
  });

  it("Google 以外・アカウント/カレンダー不明は false", () => {
    expect(canSetEventColor(subject({ source: "github" }))).toBe(false);
    expect(canSetEventColor(subject({ accountId: undefined }))).toBe(false);
    expect(canSetEventColor(subject({ calendarId: undefined }))).toBe(false);
  });
});

describe("buildEventColorRequest", () => {
  it("単発の予定: 生の event id と colorId を送る", () => {
    expect(buildEventColorRequest(subject(), "5")).toEqual({
      accountId: "acct-1",
      calendarId: "cal-1",
      eventId: "evt-1",
      colorId: "5",
    });
  });

  it("colorId が null なら、個別色を外す(空文字で送る)", () => {
    expect(buildEventColorRequest(subject(), null)?.colorId).toBe("");
  });

  it("繰り返しの1回分は、その回のインスタンス ID(親ID_UTC開始)を送る", () => {
    const req = buildEventColorRequest(
      subject({
        id: "g:acct-1:cal-1:series-1:1785128400000",
        seriesId: "g:acct-1:cal-1:series-1",
        originalStartMs: Date.UTC(2026, 6, 27, 1, 0, 0),
      }),
      "3",
    );
    expect(req?.eventId).toBe("series-1_20260727T010000Z");
  });

  it("scope が all なら、シリーズ全体(親の event id)を送る。this は、その回だけ", () => {
    const sub = subject({
      id: "g:acct-1:cal-1:series-1:1785128400000",
      seriesId: "g:acct-1:cal-1:series-1",
      originalStartMs: Date.UTC(2026, 6, 27, 1, 0, 0),
    });
    expect(buildEventColorRequest(sub, "3", "all")?.eventId).toBe("series-1");
    expect(buildEventColorRequest(sub, "3", "this")?.eventId).toBe("series-1_20260727T010000Z");
  });

  it("繰り返しでない予定では、scope が all でも、その予定自身の id", () => {
    expect(buildEventColorRequest(subject(), "3", "all")?.eventId).toBe("evt-1");
  });

  it("変えられない予定は null", () => {
    expect(buildEventColorRequest(subject({ source: "github" }), "1")).toBeNull();
  });
});

describe("colorIdOf", () => {
  it("個別色なら、その色の colorId を返す(大文字小文字は区別しない)", () => {
    expect(colorIdOf("#D50000", true)).toBe("11");
  });

  it("個別色でない・表に無い色は null(カレンダーの色)", () => {
    expect(colorIdOf("#d50000", false)).toBeNull();
    expect(colorIdOf("#123456", true)).toBeNull();
  });

  it("候補は Google の 11 色", () => {
    expect(EVENT_COLORS).toHaveLength(11);
    expect(new Set(EVENT_COLORS.map((c) => c.hex)).size).toBe(11);
  });
});
