import { describe, expect, it } from "vite-plus/test";
import type { EventAttendee } from "../model/types";
import {
  DEFAULT_GUEST_NOTIFY,
  hasNotifiableGuests,
  resolveSendUpdates,
  shouldAskGuestNotify,
  type GuestNotifySubject,
} from "./guestNotify";

function subject(overrides: Partial<GuestNotifySubject> = {}): GuestNotifySubject {
  return {
    title: "打ち合わせ",
    source: "google",
    isOrganizer: true,
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
const guest: EventAttendee = {
  email: "sato@example.com",
  displayName: "佐藤 悠",
  responseStatus: "tentative",
};
/** Gmail 以外のドメイン。**外部ゲストかどうかの判定には使わない**ことを確かめるために置く */
const outsideDomainGuest: EventAttendee = {
  email: "partner@example.co.jp",
  responseStatus: "needsAction",
};
const room: EventAttendee = {
  email: "room-a@resource.calendar.google.com",
  displayName: "本社 3F 会議室A",
  resource: true,
  responseStatus: "accepted",
};

describe("hasNotifiableGuests", () => {
  it("参加者がいない (undefined / 空配列) なら false", () => {
    expect(hasNotifiableGuests(undefined)).toBe(false);
    expect(hasNotifiableGuests([])).toBe(false);
  });

  it("自分だけの予定は false (自分にメールは飛ばない)", () => {
    expect(hasNotifiableGuests([me])).toBe(false);
  });

  it("会議室・機材だけなら false (人ではないので通知の宛先にならない)", () => {
    expect(hasNotifiableGuests([me, room])).toBe(false);
  });

  it("自分以外の人が1人でもいれば true", () => {
    expect(hasNotifiableGuests([me, guest])).toBe(true);
    expect(hasNotifiableGuests([me, room, guest])).toBe(true);
  });
});

describe("shouldAskGuestNotify", () => {
  it("ゲスト無し: 訊かない (2026-07-31 以前と何も変わらない)", () => {
    expect(shouldAskGuestNotify(subject({ attendees: undefined }))).toBe(false);
    expect(shouldAskGuestNotify(subject({ attendees: [] }))).toBe(false);
    expect(shouldAskGuestNotify(subject({ attendees: [me] }))).toBe(false);
    expect(shouldAskGuestNotify(subject({ attendees: [me, room] }))).toBe(false);
  });

  it("ゲスト有り・自分が主催: 訊く", () => {
    expect(shouldAskGuestNotify(subject({ attendees: [me, guest] }))).toBe(true);
  });

  it("ゲスト有り・自分は主催でない: 訊かない (自分の複製しか変わらず誰にも飛ばない)", () => {
    expect(shouldAskGuestNotify(subject({ isOrganizer: false, attendees: [me, guest] }))).toBe(
      false,
    );
    expect(shouldAskGuestNotify(subject({ isOrganizer: undefined, attendees: [me, guest] }))).toBe(
      false,
    );
  });

  it("外部ゲストの有無では変わらない (Google カレンダー利用者かは判定できない)", () => {
    // 同じ「自分以外が1人」でも、ドメインで結論を変えてはいけない ―― Gmail 以外の
    // アドレスで Google カレンダーを使う人も、その逆もいる。判定できないからこそ
    // 「送信しない」を externalOnly に倒して Google 側に振り分けさせる。
    expect(shouldAskGuestNotify(subject({ attendees: [me, guest] }))).toBe(true);
    expect(shouldAskGuestNotify(subject({ attendees: [me, outsideDomainGuest] }))).toBe(true);
  });

  it("繰り返し予定でも訊く (ゲストの追加・削除と違い、時刻/内容の変更は意味が定まる)", () => {
    // seriesId を持っていても判定に影響しない (この層は繰り返しかどうかを見ない)
    const recurring: GuestNotifySubject & { seriesId: string } = {
      ...subject({ attendees: [me, guest] }),
      seriesId: "g:acct-1:cal-1:series-1",
    };
    expect(shouldAskGuestNotify(recurring)).toBe(true);
  });

  it("Google 由来でない予定・ミラー・Busy プレースホルダでは訊かない", () => {
    expect(shouldAskGuestNotify(subject({ source: "local", attendees: [me, guest] }))).toBe(false);
    expect(shouldAskGuestNotify(subject({ isMirror: true, attendees: [me, guest] }))).toBe(false);
    expect(shouldAskGuestNotify(subject({ title: "予定あり", attendees: [me, guest] }))).toBe(
      false,
    );
  });
});

describe("resolveSendUpdates", () => {
  it("ゲスト無し: 選択に関わらず externalOnly (メールは1通も飛ばない)", () => {
    const noGuests = subject({ attendees: [me] });
    expect(resolveSendUpdates(noGuests, undefined)).toBe("externalOnly");
    // 手元の attendees が古くて実は誰かいた場合でも、頼まれていないメールを全員に
    // 飛ばさない ―― 訊いていない相手の choice は無視する
    expect(resolveSendUpdates(noGuests, "all")).toBe("externalOnly");
  });

  it("ゲスト有り・非主催者: 選択に関わらず externalOnly", () => {
    const notOrganizer = subject({ isOrganizer: false, attendees: [me, guest] });
    expect(resolveSendUpdates(notOrganizer, "all")).toBe("externalOnly");
  });

  it("ゲスト有り・主催者: 選ばれた値をそのまま使う", () => {
    const withGuests = subject({ attendees: [me, guest] });
    expect(resolveSendUpdates(withGuests, "all")).toBe("all");
    expect(resolveSendUpdates(withGuests, "externalOnly")).toBe("externalOnly");
  });

  it("ゲスト有り・主催者でも、選ばれていなければ externalOnly (訊いていないのに送らない)", () => {
    // 訊く前に確定してしまう経路 = カードの下端を掴むリサイズ。ここを既定の
    // 「送信する」に倒すと、問いかけ無しで全員にメールが飛ぶ
    expect(resolveSendUpdates(subject({ attendees: [me, guest] }), undefined)).toBe("externalOnly");
  });

  it("DEFAULT_GUEST_NOTIFY はダイアログの初期選択であって、未選択時の既定ではない", () => {
    expect(DEFAULT_GUEST_NOTIFY).toBe("all");
    expect(resolveSendUpdates(subject({ attendees: [me, guest] }), undefined)).not.toBe(
      DEFAULT_GUEST_NOTIFY,
    );
  });

  it("どの入力でも none を返さない (外部ゲストのカレンダーを古いまま残す値は使わない)", () => {
    const cases: GuestNotifySubject[] = [
      subject({ attendees: undefined }),
      subject({ attendees: [me] }),
      subject({ attendees: [me, guest] }),
      subject({ isOrganizer: false, attendees: [me, guest] }),
      subject({ source: "local", attendees: [me, guest] }),
    ];
    for (const s of cases) {
      for (const choice of ["all", "externalOnly", undefined] as const) {
        expect(resolveSendUpdates(s, choice)).not.toBe("none");
      }
    }
  });
});
