import { describe, expect, it, vi } from "vite-plus/test";
import type { EventAttendee, Occurrence } from "../model/types";
import {
  applyGuestChangesLocally,
  buildEventGuestsRequest,
  canEditGuests,
  guestEmailKey,
  isValidGuestEmail,
  parseGuestEmailInput,
  type GuestEditSubject,
} from "./eventGuests";

const GOOGLE_ID = "g:acct-1:cal-1:evt-1";

function subject(overrides: Partial<GuestEditSubject> = {}): GuestEditSubject {
  return {
    id: GOOGLE_ID,
    title: "打ち合わせ",
    source: "google",
    seriesId: null,
    isOrganizer: true,
    accountId: "acct-1",
    calendarId: "cal-1",
    ...overrides,
  };
}

const me: EventAttendee = {
  email: "me@example.com",
  displayName: "山田 太郎",
  self: true,
  organizer: true,
  responseStatus: "accepted",
};
const other: EventAttendee = {
  email: "sato@example.com",
  displayName: "佐藤 悠",
  responseStatus: "tentative",
};
const room: EventAttendee = {
  email: "room-a@resource.calendar.google.com",
  displayName: "会議室A",
  resource: true,
  responseStatus: "accepted",
};

describe("isValidGuestEmail", () => {
  it.each([
    "a@b.co",
    "user.name@example.com",
    "user+tag@example.co.jp",
    "USER@Example.COM",
    "a-b@sub.example-corp.com",
    "user_name@example.com",
    "'quote@example.com",
  ])("受け入れる: %s", (value: string) => {
    expect(isValidGuestEmail(value)).toBe(true);
  });

  it.each([
    ["空文字", ""],
    ["@ が無い", "example.com"],
    ["@ が2つ", "a@b@c.com"],
    ["ローカル部が空", "@example.com"],
    ["ドメインが空", "user@"],
    ["ドメインにドットが無い", "user@localhost"],
    ["TLD が1文字", "user@example.c"],
    ["TLD が数字", "user@example.12"],
    ["空白入り", "user name@example.com"],
    ["カンマ区切りの複数指定", "a@example.com,b@example.com"],
    ["セミコロン区切り", "a@example.com;b@example.com"],
    ["先頭ドット", ".user@example.com"],
    ["末尾ドット", "user.@example.com"],
    ["連続ドット", "us..er@example.com"],
    ["ドメインの連続ドット", "user@example..com"],
    ["ドメインラベルがハイフン始まり", "user@-example.com"],
    ["ドメインラベルがハイフン終わり", "user@example-.com"],
    ["日本語ドメイン (punycode 化されていない)", "user@例え.com"],
    ["改行入り", "user@example.com\n"],
  ])("弾く: %s", (_label: string, value: string) => {
    expect(isValidGuestEmail(value)).toBe(false);
  });

  it("全体の長さ上限 (254) を超えるものは弾く", () => {
    const long = `${"a".repeat(60)}@${"b".repeat(190)}.com`;
    expect(long.length).toBeGreaterThan(254);
    expect(isValidGuestEmail(long)).toBe(false);
  });

  it("ローカル部の長さ上限 (64) を超えるものは弾く", () => {
    expect(isValidGuestEmail(`${"a".repeat(65)}@example.com`)).toBe(false);
    expect(isValidGuestEmail(`${"a".repeat(64)}@example.com`)).toBe(true);
  });
});

describe("parseGuestEmailInput", () => {
  it("前後の空白を落として通す", () => {
    expect(parseGuestEmailInput("  sato2@example.com  ", [])).toEqual({
      ok: true,
      email: "sato2@example.com",
    });
  });

  it("「表示名 <アドレス>」形式を解いて通す", () => {
    expect(parseGuestEmailInput("佐藤 悠 <sato2@example.com>", [])).toEqual({
      ok: true,
      email: "sato2@example.com",
    });
  });

  it("空入力は empty", () => {
    expect(parseGuestEmailInput("   ", [])).toEqual({ ok: false, reason: "empty" });
  });

  it("不正なアドレスは invalid", () => {
    expect(parseGuestEmailInput("not-an-email", [])).toEqual({ ok: false, reason: "invalid" });
  });

  it("長すぎる入力は tooLong (invalid より前に判定する)", () => {
    const result = parseGuestEmailInput("x".repeat(300), []);
    expect(result).toEqual({ ok: false, reason: "tooLong" });
  });

  it("既にいる相手は duplicate (大小を無視して判定する)", () => {
    expect(parseGuestEmailInput("SATO@example.com", [me, other])).toEqual({
      ok: false,
      reason: "duplicate",
    });
  });

  it("自分自身は self (duplicate と区別する)", () => {
    expect(parseGuestEmailInput("me@example.com", [me, other])).toEqual({
      ok: false,
      reason: "self",
    });
  });

  it("会議室と同じアドレスも duplicate として弾く", () => {
    expect(parseGuestEmailInput(room.email!, [me, room])).toEqual({
      ok: false,
      reason: "duplicate",
    });
  });

  it("既存一覧が undefined でも通る (参加者ゼロの予定に最初の1人を足す)", () => {
    expect(parseGuestEmailInput("first@example.com", undefined)).toEqual({
      ok: true,
      email: "first@example.com",
    });
  });

  it("email を持たない参加者行 (displayName のみ) があっても落ちない", () => {
    expect(parseGuestEmailInput("first@example.com", [{ displayName: "名前だけ" }])).toEqual({
      ok: true,
      email: "first@example.com",
    });
  });
});

describe("guestEmailKey", () => {
  it("大小と前後の空白を無視したキーを返す", () => {
    expect(guestEmailKey("  Sato@Example.COM ")).toBe("sato@example.com");
  });
});

describe("canEditGuests", () => {
  it("主催者の単発 Google 予定なら true", () => {
    expect(canEditGuests(subject())).toBe(true);
  });

  it("主催者でなければ false (足しても主催者に伝わらないため)", () => {
    expect(canEditGuests(subject({ isOrganizer: undefined }))).toBe(false);
    expect(canEditGuests(subject({ isOrganizer: false }))).toBe(false);
  });

  it("繰り返しシリーズ由来なら false", () => {
    expect(canEditGuests(subject({ seriesId: "g:acct-1:cal-1:series-1" }))).toBe(false);
  });

  it("Google 由来でなければ false", () => {
    expect(canEditGuests(subject({ source: "local" }))).toBe(false);
    expect(canEditGuests(subject({ source: "github" }))).toBe(false);
  });

  it("mirror (自動生成のブロック) なら false", () => {
    expect(canEditGuests(subject({ isMirror: true }))).toBe(false);
  });

  it("Busy プレースホルダなら false", () => {
    expect(canEditGuests(subject({ title: "予定あり" }))).toBe(false);
  });

  it("accountId/calendarId が欠けていれば false", () => {
    expect(canEditGuests(subject({ accountId: undefined }))).toBe(false);
    expect(canEditGuests(subject({ calendarId: undefined }))).toBe(false);
  });

  it("id が Google の形でなければ false", () => {
    expect(canEditGuests(subject({ id: "dummy-guests-1" }))).toBe(false);
  });
});

describe("buildEventGuestsRequest", () => {
  it("追加だけの body を組み立てる", () => {
    expect(buildEventGuestsRequest(subject(), { addEmails: ["new@example.com"] })).toEqual({
      accountId: "acct-1",
      calendarId: "cal-1",
      eventId: "evt-1",
      addEmails: ["new@example.com"],
    });
  });

  it("削除だけの body を組み立てる (removeEmails のみ・addEmails のキーを持たない)", () => {
    const req = buildEventGuestsRequest(subject(), { removeEmails: ["sato@example.com"] });
    expect(req).toEqual({
      accountId: "acct-1",
      calendarId: "cal-1",
      eventId: "evt-1",
      removeEmails: ["sato@example.com"],
    });
    expect(req).not.toHaveProperty("addEmails");
  });

  it("event id にコロンが含まれていても復元できる", () => {
    const req = buildEventGuestsRequest(subject({ id: "g:acct-1:cal-1:evt:with:colons" }), {
      addEmails: ["new@example.com"],
    });
    expect(req?.eventId).toBe("evt:with:colons");
  });

  it("変更が空なら null (空リクエストを送らない)", () => {
    expect(buildEventGuestsRequest(subject(), {})).toBeNull();
    expect(buildEventGuestsRequest(subject(), { addEmails: [], removeEmails: [] })).toBeNull();
    expect(buildEventGuestsRequest(subject(), { addEmails: [""] })).toBeNull();
  });

  it("編集できない相手なら null", () => {
    expect(
      buildEventGuestsRequest(subject({ isOrganizer: false }), { addEmails: ["a@example.com"] }),
    ).toBeNull();
  });
});

describe("applyGuestChangesLocally", () => {
  it("追加した行は未返信 (needsAction) として末尾に付く", () => {
    const result = applyGuestChangesLocally([me, other], { addEmails: ["new@example.com"] });
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({ email: "new@example.com", responseStatus: "needsAction" });
  });

  it("参加者ゼロの予定にも足せる", () => {
    expect(applyGuestChangesLocally(undefined, { addEmails: ["first@example.com"] })).toEqual([
      { email: "first@example.com", responseStatus: "needsAction" },
    ]);
  });

  it("削除は大小を無視して当てる", () => {
    const result = applyGuestChangesLocally([me, other], { removeEmails: ["SATO@EXAMPLE.COM"] });
    expect(result).toEqual([me]);
  });

  it("自分・主催者・会議室は要求されても残す", () => {
    const result = applyGuestChangesLocally([me, other, room], {
      removeEmails: [me.email!, room.email!, other.email!],
    });
    expect(result).toEqual([me, room]);
  });

  it("既にいる相手を足しても増えない (重複を作らない)", () => {
    expect(applyGuestChangesLocally([me, other], { addEmails: ["SATO@example.com"] })).toEqual([
      me,
      other,
    ]);
  });

  it("同じアドレスを2回足しても1行にしかならない", () => {
    const result = applyGuestChangesLocally([], {
      addEmails: ["dup@example.com", "DUP@example.com"],
    });
    expect(result).toEqual([{ email: "dup@example.com", responseStatus: "needsAction" }]);
  });

  it("追加と削除を同時に適用できる", () => {
    const result = applyGuestChangesLocally([me, other], {
      addEmails: ["new@example.com"],
      removeEmails: ["sato@example.com"],
    });
    expect(result).toEqual([me, { email: "new@example.com", responseStatus: "needsAction" }]);
  });

  it("email を持たない行は削除要求の巻き添えにしない", () => {
    const nameless: EventAttendee = { displayName: "名前だけ" };
    expect(
      applyGuestChangesLocally([nameless, other], { removeEmails: ["sato@example.com"] }),
    ).toEqual([nameless]);
  });

  it("大量の参加者でも元の並びを保ったまま増減する", () => {
    const crowd: EventAttendee[] = Array.from({ length: 200 }, (_, i) => ({
      email: `m${i}@example.com`,
      responseStatus: "needsAction" as const,
    }));
    const result = applyGuestChangesLocally([me, ...crowd], {
      addEmails: ["extra@example.com"],
      removeEmails: ["m0@example.com", "m199@example.com"],
    });
    // 1 (自分) + 200 - 2 (削除) + 1 (追加)
    expect(result).toHaveLength(200);
    expect(result[0]).toEqual(me);
    expect(result[1].email).toBe("m1@example.com");
    expect(result[result.length - 1].email).toBe("extra@example.com");
  });

  it("変更が空なら元と同じ内容の配列を返す", () => {
    expect(applyGuestChangesLocally([me, other], {})).toEqual([me, other]);
  });
});

describe("Occurrence をそのまま渡せること (構造的な型)", () => {
  it("Occurrence は GuestEditSubject を満たす", () => {
    const occ: Occurrence = {
      id: GOOGLE_ID,
      seriesId: null,
      title: "打ち合わせ",
      startMs: 0,
      endMs: 1,
      color: "#000",
      source: "google",
      accountId: "acct-1",
      calendarId: "cal-1",
      isOrganizer: true,
      attendees: [me],
    };
    expect(canEditGuests(occ)).toBe(true);
  });

  it("id が壊れているときは console.error して null (例外を投げない)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // canEditGuests を通す形にしつつ rawGoogleEventId を壊すのは不可能なので、
    // canEditGuests 側で弾かれることを確認する (組み立て前に落ちるのが正しい)
    expect(buildEventGuestsRequest(subject({ id: "broken" }), { addEmails: ["a@b.com"] })).toBeNull();
    spy.mockRestore();
  });
});
