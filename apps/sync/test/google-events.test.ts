import { describe, expect, it } from "vite-plus/test";
import {
  deriveHasConference,
  deriveIsOrganizer,
  deriveSelfResponseStatus,
  toGoogleEventDTO,
} from "../src/core/google-events";

describe("toGoogleEventDTO", () => {
  it("copies location and description through when present", () => {
    const dto = toGoogleEventDTO({
      id: "evt-1",
      status: "confirmed",
      location: "会議室A",
      description: "<b>詳細</b>",
    });

    expect(dto.location).toBe("会議室A");
    expect(dto.description).toBe("<b>詳細</b>");
  });

  it("omits location and description when Google does not send them", () => {
    const dto = toGoogleEventDTO({ id: "evt-2", status: "confirmed" });

    expect(dto.location).toBeUndefined();
    expect(dto.description).toBeUndefined();
    // JSON.stringify drops object keys whose value is undefined, so this is what actually
    // reaches the client via c.json() — assert the wire format, not just the in-memory object
    // (which always has the key present with value `undefined` due to object-literal syntax).
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain("location");
    expect(serialized).not.toContain("description");
  });

  it("copies iCalUID through when present, and drops it from the wire format when absent", () => {
    const withUid = toGoogleEventDTO({
      id: "evt-3",
      status: "confirmed",
      iCalUID: "uid-123@google.com",
    });
    expect(withUid.iCalUID).toBe("uid-123@google.com");

    const withoutUid = toGoogleEventDTO({ id: "evt-4", status: "confirmed" });
    expect(withoutUid.iCalUID).toBeUndefined();
    expect(JSON.stringify(withoutUid)).not.toContain("iCalUID");
  });

  it("copies eventType through when present (不在レール表示、2026-07-22)", () => {
    const dto = toGoogleEventDTO({
      id: "evt-5",
      status: "confirmed",
      eventType: "outOfOffice",
    });
    expect(dto.eventType).toBe("outOfOffice");
  });

  it("omits eventType when Google does not send it", () => {
    const dto = toGoogleEventDTO({ id: "evt-6", status: "confirmed" });
    expect(dto.eventType).toBeUndefined();
    expect(JSON.stringify(dto)).not.toContain("eventType");
  });
});

// 参加ステータス表示 (RSVP、2026-07-22)。純関数 (deriveSelfResponseStatus/deriveIsOrganizer/
// deriveHasConference) を個別にテストし、toGoogleEventDTO の配線が実際にそれらを呼んでいることも
// 統合的に確認する (isOutOfOffice/toGoogleEventDTO と同じ流儀)。
describe("deriveSelfResponseStatus", () => {
  it("self:true のエントリの responseStatus を返す", () => {
    expect(
      deriveSelfResponseStatus([
        { email: "other@example.com", self: false, responseStatus: "accepted" },
        { email: "me@example.com", self: true, responseStatus: "declined" },
      ]),
    ).toBe("declined");
  });

  it("accepted/tentative/needsAction もそのまま通す", () => {
    expect(deriveSelfResponseStatus([{ self: true, responseStatus: "accepted" }])).toBe("accepted");
    expect(deriveSelfResponseStatus([{ self: true, responseStatus: "tentative" }])).toBe(
      "tentative",
    );
    expect(deriveSelfResponseStatus([{ self: true, responseStatus: "needsAction" }])).toBe(
      "needsAction",
    );
  });

  it("attendees が無ければ undefined(自分だけの予定・招待者がいない予定)", () => {
    expect(deriveSelfResponseStatus(undefined)).toBeUndefined();
  });

  it("attendees はあるが self:true のエントリが無ければ undefined", () => {
    expect(
      deriveSelfResponseStatus([
        { email: "other@example.com", self: false, responseStatus: "accepted" },
      ]),
    ).toBeUndefined();
  });

  it("responseStatus が想定外の値なら undefined に丸める(GoogleEventDTO の union を逸脱させない)", () => {
    expect(
      deriveSelfResponseStatus([{ self: true, responseStatus: "unknownValue" }]),
    ).toBeUndefined();
  });
});

describe("deriveIsOrganizer", () => {
  it("organizer.self===true なら true", () => {
    expect(deriveIsOrganizer({ self: true })).toBe(true);
  });

  it("organizer.self===false なら undefined", () => {
    expect(deriveIsOrganizer({ self: false })).toBeUndefined();
  });

  it("organizer 自体が無ければ undefined", () => {
    expect(deriveIsOrganizer(undefined)).toBeUndefined();
  });
});

describe("deriveHasConference", () => {
  it("conferenceData があれば true(中身は見ない、空オブジェクトでも true)", () => {
    expect(deriveHasConference({}, undefined)).toBe(true);
    expect(deriveHasConference({ entryPoints: [] }, undefined)).toBe(true);
  });

  it("hangoutLink があれば true", () => {
    expect(deriveHasConference(undefined, "https://meet.google.com/abc-defg-hij")).toBe(true);
  });

  it("どちらも無ければ undefined", () => {
    expect(deriveHasConference(undefined, undefined)).toBeUndefined();
  });

  it("hangoutLink が空文字なら false 扱い(undefined)", () => {
    expect(deriveHasConference(undefined, "")).toBeUndefined();
  });
});

describe("toGoogleEventDTO: RSVP 表示フィールドの配線 (2026-07-22)", () => {
  it("attendees/organizer/conferenceData/hangoutLink から派生フィールドを立て、生の配列は捨てる", () => {
    const dto = toGoogleEventDTO({
      id: "evt-rsvp",
      status: "confirmed",
      attendees: [{ email: "me@example.com", self: true, responseStatus: "tentative" }],
      organizer: { self: true },
      hangoutLink: "https://meet.google.com/abc-defg-hij",
    });

    expect(dto.selfResponseStatus).toBe("tentative");
    expect(dto.isOrganizer).toBe(true);
    expect(dto.hasConference).toBe(true);
    // raw な attendees/organizer/conferenceData/hangoutLink は DTO に残らない(リーン維持)
    expect(dto).not.toHaveProperty("attendees");
    expect(dto).not.toHaveProperty("organizer");
    expect(dto).not.toHaveProperty("conferenceData");
    expect(dto).not.toHaveProperty("hangoutLink");
  });

  it("attendees/organizer/会議リンクが無ければ全て undefined のまま(wire format からも消える)", () => {
    const dto = toGoogleEventDTO({ id: "evt-no-rsvp", status: "confirmed" });

    expect(dto.selfResponseStatus).toBeUndefined();
    expect(dto.isOrganizer).toBeUndefined();
    expect(dto.hasConference).toBeUndefined();
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain("selfResponseStatus");
    expect(serialized).not.toContain("isOrganizer");
    expect(serialized).not.toContain("hasConference");
  });
});
