import { describe, expect, it } from "vite-plus/test";
import { resolveEventDetailMeetingView } from "./eventDetailView";

const HUDDLE = "https://app.slack.com/huddle/T25JPTN0M/CGDR6P8KW";
const MEET = "https://meet.google.com/abc-defg-hij";

describe("resolveEventDetailMeetingView", () => {
  it("会議 URL も location も無ければ何も出さない", () => {
    expect(resolveEventDetailMeetingView({})).toEqual({
      meetingUrl: undefined,
      provider: null,
      meetingLinkLabel: "会議に参加",
      showConferenceNote: false,
      locationRow: undefined,
    });
  });

  it("Slack ハドル (location に URL) は参加リンクだけを出し、場所行は二重に出さない", () => {
    const view = resolveEventDetailMeetingView({ location: HUDDLE });
    expect(view.meetingUrl).toBe(HUDDLE);
    expect(view.provider).toBe("slack");
    expect(view.meetingLinkLabel).toBe("Slack ハドルに参加");
    expect(view.locationRow).toBeUndefined();
  });

  it("location 末尾の空白があっても場所行と参加リンクが二重にならない(trim 同士で比較)", () => {
    const view = resolveEventDetailMeetingView({ location: `  ${HUDDLE}  ` });
    expect(view.meetingUrl).toBe(HUDDLE);
    expect(view.locationRow).toBeUndefined();
  });

  it("Meet + 会議室名の location は参加リンクと場所行の両方を出す", () => {
    const view = resolveEventDetailMeetingView({
      conferenceUrl: MEET,
      location: "本社 3F 会議室A",
      hasConference: true,
    });
    expect(view.meetingUrl).toBe(MEET);
    expect(view.provider).toBe("meet");
    expect(view.meetingLinkLabel).toBe("Google Meetに参加");
    expect(view.locationRow).toBe("本社 3F 会議室A");
    // 参加リンクを出せるので汎用の「オンライン会議あり」行は省く
    expect(view.showConferenceNote).toBe(false);
  });

  it("会議はあるが URL が取れない(電話参加のみ等)ときだけ汎用行を出す", () => {
    const view = resolveEventDetailMeetingView({ hasConference: true });
    expect(view.showConferenceNote).toBe(true);
    expect(view.meetingUrl).toBeUndefined();
  });

  it("プロバイダ不明の会議 URL(社内ツール等)でも参加リンクは出す", () => {
    const view = resolveEventDetailMeetingView({
      conferenceUrl: "https://meeting.example.com/room/1",
      hasConference: true,
    });
    expect(view.meetingUrl).toBe("https://meeting.example.com/room/1");
    expect(view.provider).toBeNull();
    expect(view.meetingLinkLabel).toBe("会議に参加");
    expect(view.showConferenceNote).toBe(false);
  });

  it("住所テキストの location は会議扱いせず場所行だけを出す", () => {
    const view = resolveEventDetailMeetingView({ location: "東京都千代田区1-1" });
    expect(view.meetingUrl).toBeUndefined();
    expect(view.locationRow).toBe("東京都千代田区1-1");
  });

  it("空白だけの location は場所行を出さない", () => {
    expect(resolveEventDetailMeetingView({ location: "   " }).locationRow).toBeUndefined();
  });
});
