import { describe, expect, it } from "vite-plus/test";
import { buildEventMeetRequest, canAddMeet, type MeetSubject } from "./eventMeet";

function subject(overrides: Partial<MeetSubject> = {}): MeetSubject {
  return {
    id: "g:acct-1:cal-1:evt-1",
    title: "打ち合わせ",
    source: "google",
    accountId: "acct-1",
    calendarId: "cal-1",
    seriesId: null,
    ...overrides,
  };
}

describe("canAddMeet", () => {
  it("会議の無い、編集できる Google の予定なら true", () => {
    expect(canAddMeet(subject())).toBe(true);
  });

  it("すでに会議がある予定は false(hasConference / conferenceUrl のどちらでも)", () => {
    expect(canAddMeet(subject({ hasConference: true }))).toBe(false);
    expect(canAddMeet(subject({ conferenceUrl: "https://meet.google.com/a" }))).toBe(false);
  });

  it("Google 以外・ミラー・Busy・不在・勤務場所・書き込み先不明は false", () => {
    expect(canAddMeet(subject({ source: "local" }))).toBe(false);
    expect(canAddMeet(subject({ isMirror: true }))).toBe(false);
    expect(canAddMeet(subject({ title: "Busy" }))).toBe(false);
    expect(canAddMeet(subject({ isOutOfOffice: true }))).toBe(false);
    expect(canAddMeet(subject({ isWorkingLocation: true }))).toBe(false);
    expect(canAddMeet(subject({ accountId: undefined }))).toBe(false);
    expect(canAddMeet(subject({ calendarId: undefined }))).toBe(false);
  });
});

describe("buildEventMeetRequest", () => {
  it("単発の予定: 生の event id を送る", () => {
    expect(buildEventMeetRequest(subject())).toEqual({
      accountId: "acct-1",
      calendarId: "cal-1",
      eventId: "evt-1",
    });
  });

  it("繰り返しの1回分は、親のシリーズの id を送る(会議は繰り返し全体に付く)", () => {
    const req = buildEventMeetRequest(
      subject({ id: "g:acct-1:cal-1:series-1:1785128400000", seriesId: "g:acct-1:cal-1:series-1" }),
    );
    expect(req?.eventId).toBe("series-1");
  });

  it("追加できない予定は null", () => {
    expect(buildEventMeetRequest(subject({ hasConference: true }))).toBeNull();
  });
});
