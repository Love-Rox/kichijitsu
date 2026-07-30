import { describe, expect, it } from "vite-plus/test";
import {
  deriveAttendeeList,
  MAX_DTO_ATTENDEES,
  deriveConferenceUrl,
  deriveHasConference,
  deriveIsOrganizer,
  derivePopupReminderMinutes,
  deriveReminders,
  deriveSelfResponseStatus,
  MAX_REMINDER_MINUTES,
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
    // attendees は 2026-07-30 から DTO に載る(参加者の表示)。ただし**生のまま**ではなく
    // deriveAttendeeList が画面に出す分だけへ絞った形 ―― 詳細は deriveAttendeeList の describe
    expect(dto.attendees).toEqual([
      { email: "me@example.com", responseStatus: "tentative", self: true },
    ]);
    // raw な organizer/conferenceData/hangoutLink は DTO に残らない(リーン維持)
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

/**
 * 参加者一覧 (2026-07-30)。attendees は「そのまま通す」のではなく、画面に出す分だけへ
 * 絞ってから件数上限で切り詰める ―― 境界 (0人 / 自分だけ / 会議室 / displayName 無し /
 * 応答状態の全種類 / 数十人) をここで固定する。
 */
describe("deriveAttendeeList", () => {
  it("attendees が無い予定はキー自体を持たない", () => {
    expect(deriveAttendeeList({ id: "e", status: "confirmed" })).toEqual({});
  });

  it("attendees が空配列でもキー自体を持たない", () => {
    expect(deriveAttendeeList({ id: "e", status: "confirmed", attendees: [] })).toEqual({});
  });

  it("自分だけの1人でもそのまま載せる (RSVP の派生値とは別に一覧も要る)", () => {
    expect(
      deriveAttendeeList({
        id: "e",
        status: "confirmed",
        attendees: [{ email: "me@example.com", self: true, organizer: true, responseStatus: "accepted" }],
      }),
    ).toEqual({
      attendees: [
        { email: "me@example.com", responseStatus: "accepted", self: true, organizer: true },
      ],
    });
  });

  it("画面に出さないフィールド (comment/optional/id/additionalGuests) は落とす", () => {
    const { attendees } = deriveAttendeeList({
      id: "e",
      status: "confirmed",
      attendees: [
        {
          email: "a@example.com",
          displayName: "あさひ",
          responseStatus: "tentative",
          // 型には無いが Google は返してくる。写さないことを固定する
          ...({ comment: "遅れます", optional: true, id: "profile-1", additionalGuests: 2 } as object),
        },
      ],
    });
    expect(attendees).toEqual([
      { email: "a@example.com", displayName: "あさひ", responseStatus: "tentative" },
    ]);
  });

  it("displayName が無い参加者は email だけで通す", () => {
    const { attendees } = deriveAttendeeList({
      id: "e",
      status: "confirmed",
      attendees: [{ email: "nobody@example.com", responseStatus: "needsAction" }],
    });
    expect(attendees).toEqual([{ email: "nobody@example.com", responseStatus: "needsAction" }]);
  });

  it("会議室 (resource) も一覧には載せる (人かどうかの判別は表示側の仕事)", () => {
    const { attendees } = deriveAttendeeList({
      id: "e",
      status: "confirmed",
      attendees: [
        { email: "me@example.com", self: true, responseStatus: "accepted" },
        { email: "room-a@resource.calendar.google.com", displayName: "会議室A", resource: true },
      ],
    });
    expect(attendees).toEqual([
      { email: "me@example.com", responseStatus: "accepted", self: true },
      {
        email: "room-a@resource.calendar.google.com",
        displayName: "会議室A",
        resource: true,
      },
    ]);
  });

  it("応答状態の4値すべてを通し、union に無い値だけを落とす", () => {
    const { attendees } = deriveAttendeeList({
      id: "e",
      status: "confirmed",
      attendees: [
        { email: "a@example.com", responseStatus: "accepted" },
        { email: "b@example.com", responseStatus: "declined" },
        { email: "c@example.com", responseStatus: "tentative" },
        { email: "d@example.com", responseStatus: "needsAction" },
        { email: "e@example.com", responseStatus: "somethingNew" },
      ],
    });
    expect(attendees?.map((a) => a.responseStatus)).toEqual([
      "accepted",
      "declined",
      "tentative",
      "needsAction",
      undefined,
    ]);
  });

  it("email も displayName も無い行は落とし、attendeesOmitted を立てる", () => {
    expect(
      deriveAttendeeList({
        id: "e",
        status: "confirmed",
        attendees: [{ email: "a@example.com" }, { responseStatus: "accepted" }],
      }),
    ).toEqual({ attendees: [{ email: "a@example.com" }], attendeesOmitted: true });
  });

  it("全員が出しようのない行なら、空配列ではなくキー自体を持たない", () => {
    expect(
      deriveAttendeeList({ id: "e", status: "confirmed", attendees: [{ responseStatus: "accepted" }] }),
    ).toEqual({});
  });

  it("Google 自身が attendeesOmitted を立ててきたらそのまま伝える", () => {
    const result = deriveAttendeeList({
      id: "e",
      status: "confirmed",
      attendeesOmitted: true,
      attendees: [{ email: "me@example.com", self: true }],
    });
    expect(result.attendeesOmitted).toBe(true);
  });

  it("上限ちょうど (50人) は切り詰めず、順序も変えない", () => {
    const raw = Array.from({ length: MAX_DTO_ATTENDEES }, (_, i) => ({
      email: `p${i}@example.com`,
    }));
    const result = deriveAttendeeList({ id: "e", status: "confirmed", attendees: raw });
    expect(result.attendees).toHaveLength(MAX_DTO_ATTENDEES);
    expect(result.attendees?.[0]?.email).toBe("p0@example.com");
    expect(result.attendeesOmitted).toBeUndefined();
  });

  it("数十人を超えたら上限まで切り詰め、attendeesOmitted を立てる", () => {
    const raw = Array.from({ length: MAX_DTO_ATTENDEES + 30 }, (_, i) => ({
      email: `p${i}@example.com`,
    }));
    const result = deriveAttendeeList({ id: "e", status: "confirmed", attendees: raw });
    expect(result.attendees).toHaveLength(MAX_DTO_ATTENDEES);
    expect(result.attendeesOmitted).toBe(true);
  });

  it("切り詰めるときも自分と主催者は必ず残す (末尾にいても消さない)", () => {
    const raw = [
      ...Array.from({ length: MAX_DTO_ATTENDEES + 10 }, (_, i) => ({ email: `p${i}@example.com` })),
      { email: "boss@example.com", organizer: true, responseStatus: "accepted" },
      { email: "me@example.com", self: true, responseStatus: "needsAction" },
    ];
    const result = deriveAttendeeList({ id: "e", status: "confirmed", attendees: raw });
    expect(result.attendees).toHaveLength(MAX_DTO_ATTENDEES);
    expect(result.attendees?.[0]).toEqual({
      email: "boss@example.com",
      responseStatus: "accepted",
      organizer: true,
    });
    expect(result.attendees?.[1]).toEqual({
      email: "me@example.com",
      responseStatus: "needsAction",
      self: true,
    });
    expect(result.attendeesOmitted).toBe(true);
  });

  it("toGoogleEventDTO 経由でも attendees が載る (派生値の selfResponseStatus と両立する)", () => {
    const dto = toGoogleEventDTO({
      id: "e",
      status: "confirmed",
      organizer: { self: false },
      attendees: [
        { email: "boss@example.com", displayName: "上司", organizer: true, responseStatus: "accepted" },
        { email: "me@example.com", self: true, responseStatus: "tentative" },
      ],
    });
    expect(dto.selfResponseStatus).toBe("tentative");
    expect(dto.attendees).toHaveLength(2);
    expect(dto.attendeesOmitted).toBeUndefined();
  });
});

// 予定ごとのリマインダー (2026-07-31)。公式仕様は EventRemindersDTO のコメント参照
// (method は email/popup の2値、minutes は 0〜40320、overrides は最大5件、
//  useDefault:true のときは overrides を持てない)。
describe("derivePopupReminderMinutes", () => {
  it("popup だけを拾い、email は落とす (メールは Google 自身が送るので二重に出さない)", () => {
    expect(
      derivePopupReminderMinutes([
        { method: "email", minutes: 1440 },
        { method: "popup", minutes: 10 },
      ]),
    ).toEqual([10]);
  });

  it("method が無い/未知の値のエントリは採らない (安全側へ倒す)", () => {
    expect(
      derivePopupReminderMinutes([
        { minutes: 5 },
        { method: "sms", minutes: 5 },
        { method: "popup", minutes: 5 },
      ]),
    ).toEqual([5]);
  });

  it("昇順・重複除去して返す", () => {
    expect(
      derivePopupReminderMinutes([
        { method: "popup", minutes: 60 },
        { method: "popup", minutes: 10 },
        { method: "popup", minutes: 60 },
      ]),
    ).toEqual([10, 60]);
  });

  it("0 分 (開始時刻ちょうど) は有効な値", () => {
    expect(derivePopupReminderMinutes([{ method: "popup", minutes: 0 }])).toEqual([0]);
  });

  it("公式の上限 40320 分 (4週間) までは通し、それを超える値・負値・非整数は落とす", () => {
    expect(
      derivePopupReminderMinutes([
        { method: "popup", minutes: MAX_REMINDER_MINUTES },
        { method: "popup", minutes: MAX_REMINDER_MINUTES + 1 },
        { method: "popup", minutes: -1 },
        { method: "popup", minutes: 10.5 },
      ]),
    ).toEqual([MAX_REMINDER_MINUTES]);
  });

  it("minutes が欠けているエントリは落とす", () => {
    expect(derivePopupReminderMinutes([{ method: "popup" }])).toEqual([]);
  });

  it("公式の上限件数 (5件) を超えたぶんは切り捨てる", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ method: "popup", minutes: i + 1 }));
    expect(derivePopupReminderMinutes(many)).toEqual([1, 2, 3, 4, 5]);
  });

  it("undefined / 空配列は空配列", () => {
    expect(derivePopupReminderMinutes(undefined)).toEqual([]);
    expect(derivePopupReminderMinutes([])).toEqual([]);
  });
});

describe("deriveReminders", () => {
  it("useDefault: true はそのまま宣言として載せる (分数はカレンダー既定側にある)", () => {
    expect(
      deriveReminders({ id: "e", status: "confirmed", reminders: { useDefault: true } }),
    ).toEqual({ reminders: { useDefault: true } });
  });

  it("useDefault: false + overrides は popup の分数に潰す", () => {
    expect(
      deriveReminders({
        id: "e",
        status: "confirmed",
        reminders: {
          useDefault: false,
          overrides: [
            { method: "popup", minutes: 10 },
            { method: "email", minutes: 60 },
          ],
        },
      }),
    ).toEqual({ reminders: { minutes: [10] } });
  });

  it("overrides が空 = リマインダーなし。**空配列でも省略しない** (未同期と区別するため)", () => {
    expect(
      deriveReminders({ id: "e", status: "confirmed", reminders: { useDefault: false, overrides: [] } }),
    ).toEqual({ reminders: { minutes: [] } });
    expect(
      deriveReminders({ id: "e", status: "confirmed", reminders: { useDefault: false } }),
    ).toEqual({ reminders: { minutes: [] } });
  });

  it("email だけの予定は「リマインダーなし」に落ちる (デスクトップ通知としては出さない)", () => {
    expect(
      deriveReminders({
        id: "e",
        status: "confirmed",
        reminders: { useDefault: false, overrides: [{ method: "email", minutes: 30 }] },
      }),
    ).toEqual({ reminders: { minutes: [] } });
  });

  it("useDefault と overrides が両立していたら useDefault を優先する (公式は両立時を未定義とする)", () => {
    expect(
      deriveReminders({
        id: "e",
        status: "confirmed",
        reminders: { useDefault: true, overrides: [{ method: "popup", minutes: 5 }] },
      }),
    ).toEqual({ reminders: { useDefault: true } });
  });

  it("reminders 自体が来なければキーを持たない (削除通知は id しか持たないことが保証されている)", () => {
    expect(deriveReminders({ id: "e", status: "cancelled" })).toEqual({});
  });

  it("toGoogleEventDTO 経由でも reminders が載り、無い場合はワイヤ形式にも出ない", () => {
    const withReminders = toGoogleEventDTO({
      id: "e",
      status: "confirmed",
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] },
    });
    expect(withReminders.reminders).toEqual({ minutes: [15] });

    const without = toGoogleEventDTO({ id: "e2", status: "confirmed" });
    expect(without.reminders).toBeUndefined();
    expect(JSON.stringify(without)).not.toContain("reminders");
  });
});
