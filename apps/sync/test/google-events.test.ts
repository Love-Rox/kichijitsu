import { describe, expect, it } from "vite-plus/test";
import {
  deriveConferenceUrl,
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

describe("deriveConferenceUrl", () => {
  it("Meet の典型形: entryPointType==='video' の uri を採用する", () => {
    expect(
      deriveConferenceUrl(
        {
          entryPoints: [
            { entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" },
            { entryPointType: "phone", uri: "tel:+81-3-0000-0000" },
          ],
        },
        "https://meet.google.com/abc-defg-hij",
      ),
    ).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("video エントリは配列の順番によらず電話より優先される", () => {
    expect(
      deriveConferenceUrl(
        {
          entryPoints: [
            { entryPointType: "phone", uri: "tel:+81-3-0000-0000" },
            { entryPointType: "video", uri: "https://meet.google.com/xyz-abcd-efg" },
          ],
        },
        undefined,
      ),
    ).toBe("https://meet.google.com/xyz-abcd-efg");
  });

  it("Zoom アドオンの形 (video エントリ + hangoutLink なし) も拾う", () => {
    expect(
      deriveConferenceUrl(
        {
          entryPoints: [
            { entryPointType: "video", uri: "https://example.zoom.us/j/1234567890?pwd=xxx" },
            { entryPointType: "phone", uri: "tel:+81-3-0000-0000" },
          ],
        },
        undefined,
      ),
    ).toBe("https://example.zoom.us/j/1234567890?pwd=xxx");
  });

  it("entryPointType が未知/欠落でも http(s) の uri なら先頭のものを採用する", () => {
    expect(
      deriveConferenceUrl({ entryPoints: [{ uri: "https://example.com/meet/1" }] }, undefined),
    ).toBe("https://example.com/meet/1");
  });

  it("entryPoints が電話のみなら undefined (tel: は参加リンクにしない)", () => {
    expect(
      deriveConferenceUrl(
        { entryPoints: [{ entryPointType: "phone", uri: "tel:+81-3-0000-0000", pin: "12345" }] },
        undefined,
      ),
    ).toBeUndefined();
  });

  it("conferenceData が空オブジェクトなら undefined (hasConference は true でも URL は無い)", () => {
    expect(deriveConferenceUrl({}, undefined)).toBeUndefined();
    expect(deriveHasConference({}, undefined)).toBe(true);
  });

  it("conferenceData が無く hangoutLink だけあればそれを使う", () => {
    expect(deriveConferenceUrl(undefined, "https://meet.google.com/abc-defg-hij")).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
  });

  it("entryPoints で拾えないときは hangoutLink にフォールバックする", () => {
    expect(
      deriveConferenceUrl(
        { entryPoints: [{ entryPointType: "phone", uri: "tel:+81-3-0000-0000" }] },
        "https://meet.google.com/fallback-abc",
      ),
    ).toBe("https://meet.google.com/fallback-abc");
  });

  it("両方無ければ undefined", () => {
    expect(deriveConferenceUrl(undefined, undefined)).toBeUndefined();
  });

  it("形が想定外 (配列でない entryPoints・要素が文字列・空の hangoutLink) でも throw せず undefined", () => {
    expect(deriveConferenceUrl({ entryPoints: "nope" }, undefined)).toBeUndefined();
    expect(deriveConferenceUrl({ entryPoints: ["https://meet.google.com/x"] }, "")).toBeUndefined();
    expect(deriveConferenceUrl("string", undefined)).toBeUndefined();
    expect(deriveConferenceUrl(null, undefined)).toBeUndefined();
  });

  it("http/https 以外のスキームの hangoutLink は採用しない", () => {
    expect(deriveConferenceUrl(undefined, "tel:+81-3-0000-0000")).toBeUndefined();
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
    // 参加 URL (2026-07-25): hangoutLink だけの形でも conferenceUrl に載る
    expect(dto.conferenceUrl).toBe("https://meet.google.com/abc-defg-hij");
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
    expect(dto.conferenceUrl).toBeUndefined();
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain("selfResponseStatus");
    expect(serialized).not.toContain("isOrganizer");
    expect(serialized).not.toContain("hasConference");
    expect(serialized).not.toContain("conferenceUrl");
  });

  it("conferenceData の entryPoints から参加 URL を DTO へ写す (2026-07-25)", () => {
    const dto = toGoogleEventDTO({
      id: "evt-meet",
      status: "confirmed",
      conferenceData: {
        entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }],
      },
    });

    expect(dto.hasConference).toBe(true);
    expect(dto.conferenceUrl).toBe("https://meet.google.com/abc-defg-hij");
    expect(dto).not.toHaveProperty("conferenceData");
  });

  it("電話のみの会議は hasConference だけ立ち、conferenceUrl は付かない (2026-07-25)", () => {
    const dto = toGoogleEventDTO({
      id: "evt-phone-only",
      status: "confirmed",
      conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+81-3-0000-0000" }] },
    });

    expect(dto.hasConference).toBe(true);
    expect(dto.conferenceUrl).toBeUndefined();
  });
});
