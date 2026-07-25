import { describe, expect, it } from "vite-plus/test";
import { detectMeetingProvider, meetingLocationLabel, meetingProviderLabel } from "./meetingLinks";

describe("detectMeetingProvider", () => {
  it("Slack ハドル URL(実データ)を slack と判定する", () => {
    expect(detectMeetingProvider("https://app.slack.com/huddle/T25JPTN0M/CGDR6P8KW")).toBe("slack");
  });

  it("ワークスペースのサブドメイン (*.slack.com) の huddle も slack と判定する", () => {
    expect(detectMeetingProvider("https://myteam.slack.com/huddle/T123/C456")).toBe("slack");
  });

  it("slack.com でも huddle でないパス(チャンネル等)は会議扱いしない", () => {
    expect(detectMeetingProvider("https://app.slack.com/client/T25JPTN0M/CGDR6P8KW")).toBeNull();
  });

  it("ホストの大文字小文字は無視する", () => {
    expect(detectMeetingProvider("HTTPS://APP.SLACK.COM/HUDDLE/T1/C1")).toBe("slack");
  });

  it("前後の空白は無視する", () => {
    expect(detectMeetingProvider("  https://app.slack.com/huddle/T1/C1  ")).toBe("slack");
  });

  it("Google Meet を meet と判定する", () => {
    expect(detectMeetingProvider("https://meet.google.com/abc-defg-hij")).toBe("meet");
  });

  it("Zoom を zoom と判定する(サブドメイン付きの参加 URL を含む)", () => {
    expect(detectMeetingProvider("https://zoom.us/j/1234567890")).toBe("zoom");
    expect(detectMeetingProvider("https://example.zoom.us/j/1234567890?pwd=abc")).toBe("zoom");
  });

  it("Teams を teams と判定する", () => {
    expect(detectMeetingProvider("https://teams.microsoft.com/l/meetup-join/19%3ameeting")).toBe(
      "teams",
    );
  });

  it("住所テキストは null", () => {
    expect(detectMeetingProvider("東京都千代田区丸の内1-1-1 パレスビル 5F")).toBeNull();
  });

  it("会議室名も null", () => {
    expect(detectMeetingProvider("第2会議室")).toBeNull();
  });

  it("undefined / 空文字 / 空白のみは null", () => {
    expect(detectMeetingProvider(undefined)).toBeNull();
    expect(detectMeetingProvider("")).toBeNull();
    expect(detectMeetingProvider("   ")).toBeNull();
  });

  it("URL として壊れている文字列は null(例外にしない)", () => {
    expect(detectMeetingProvider("https://")).toBeNull();
    expect(detectMeetingProvider("http//app.slack.com/huddle/T1/C1")).toBeNull();
  });

  it("http/https 以外のスキームは null", () => {
    expect(detectMeetingProvider("mailto:someone@example.com")).toBeNull();
    expect(detectMeetingProvider("tel:+81312345678")).toBeNull();
  });

  it("会議サービス以外の URL は null(生 URL でも会議扱いしない)", () => {
    expect(detectMeetingProvider("https://example.com/rooms/5")).toBeNull();
  });

  it("似ているだけの別ドメインは誤判定しない", () => {
    expect(detectMeetingProvider("https://slack.com.evil.example/huddle/T1/C1")).toBeNull();
    expect(detectMeetingProvider("https://notzoom.us/j/1")).toBeNull();
    expect(detectMeetingProvider("https://meet.google.com.evil.example/abc")).toBeNull();
  });

  it("http(平文)でも判定する", () => {
    expect(detectMeetingProvider("http://zoom.us/j/1")).toBe("zoom");
  });
});

describe("meetingProviderLabel", () => {
  it("各プロバイダの表示ラベルを返す", () => {
    expect(meetingProviderLabel("slack")).toBe("Slack ハドル");
    expect(meetingProviderLabel("meet")).toBe("Google Meet");
    expect(meetingProviderLabel("zoom")).toBe("Zoom");
    expect(meetingProviderLabel("teams")).toBe("Teams");
  });
});

describe("meetingLocationLabel", () => {
  it("会議 URL はプロバイダラベルに置き換える", () => {
    expect(meetingLocationLabel("https://app.slack.com/huddle/T25JPTN0M/CGDR6P8KW")).toBe(
      "Slack ハドル",
    );
  });

  it("会議 URL でない location はそのまま返す", () => {
    expect(meetingLocationLabel("第2会議室")).toBe("第2会議室");
  });

  it("undefined はそのまま undefined", () => {
    expect(meetingLocationLabel(undefined)).toBeUndefined();
  });
});
