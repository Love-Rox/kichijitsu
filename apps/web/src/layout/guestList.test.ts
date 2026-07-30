import { describe, expect, it } from "vite-plus/test";
import type { EventAttendee } from "../model/types";
import { buildGuestListView, guestRemovalBlockReason, GUEST_PREVIEW_COUNT } from "./guestList";

/** 数十人ぶんの参加者を作る (数え方・切り詰めの境界確認用) */
function manyGuests(count: number): EventAttendee[] {
  return Array.from({ length: count }, (_, i) => ({
    email: `p${i}@example.com`,
    displayName: `参加者${i}`,
    responseStatus: "needsAction" as const,
  }));
}

describe("buildGuestListView", () => {
  it("参加者がいない予定は null (欄ごと出さない)", () => {
    expect(buildGuestListView(undefined)).toBeNull();
    expect(buildGuestListView([])).toBeNull();
  });

  it("自分だけの1人でも一覧に出す", () => {
    const view = buildGuestListView([
      { email: "me@example.com", displayName: "自分の名前", self: true, responseStatus: "accepted" },
    ]);
    expect(view?.countLabel).toBe("ゲスト 1人");
    expect(view?.summaryLabel).toBe("参加 1");
    expect(view?.guests).toEqual([
      {
        key: "0:me@example.com",
        label: "自分の名前",
        subLabel: "me@example.com",
        responseStatus: "accepted",
        note: "自分",
        email: "me@example.com",
        // 自分自身は外せない (ゲストの追加・削除、2026-07-31)
        removable: false,
      },
    ]);
  });

  it("主催者を先頭、次に自分、残りは元の順のまま", () => {
    const view = buildGuestListView([
      { email: "c@example.com", displayName: "しい" },
      { email: "me@example.com", displayName: "自分", self: true },
      { email: "a@example.com", displayName: "えい" },
      { email: "boss@example.com", displayName: "主催", organizer: true },
    ]);
    expect(view?.guests.map((g) => g.label)).toEqual(["主催", "自分", "しい", "えい"]);
    expect(view?.guests.map((g) => g.note)).toEqual(["主催者", "自分", undefined, undefined]);
  });

  it("自分が主催者のときは注記を「主催者」に寄せる (2つ重ねない)", () => {
    const view = buildGuestListView([
      { email: "me@example.com", displayName: "自分", self: true, organizer: true },
      { email: "a@example.com", displayName: "えい" },
    ]);
    expect(view?.guests[0]?.note).toBe("主催者");
    expect(view?.guests).toHaveLength(2);
  });

  it("会議室 (resource) は人数にも出欠にも含めず、別枠に出す", () => {
    const view = buildGuestListView([
      { email: "me@example.com", displayName: "自分", self: true, responseStatus: "accepted" },
      {
        email: "room-a@resource.calendar.google.com",
        displayName: "会議室A",
        resource: true,
        responseStatus: "accepted",
      },
      { email: "room-b@resource.calendar.google.com", displayName: "会議室B", resource: true },
    ]);
    expect(view?.countLabel).toBe("ゲスト 1人");
    expect(view?.summaryLabel).toBe("参加 1");
    expect(view?.rooms).toEqual(["会議室A", "会議室B"]);
    expect(view?.guests).toHaveLength(1);
  });

  it("会議室しかいない予定でも null にはしない (押さえた部屋は出す価値がある)", () => {
    const view = buildGuestListView([
      { email: "room-a@resource.calendar.google.com", displayName: "会議室A", resource: true },
    ]);
    expect(view?.guests).toEqual([]);
    expect(view?.rooms).toEqual(["会議室A"]);
    expect(view?.countLabel).toBe("ゲスト 0人");
    expect(view?.summaryLabel).toBe("");
  });

  it("displayName が無ければメールを主表示にし、副表示は重複させない", () => {
    const view = buildGuestListView([{ email: "nobody@example.com" }]);
    expect(view?.guests[0]?.label).toBe("nobody@example.com");
    expect(view?.guests[0]?.subLabel).toBeUndefined();
  });

  it("displayName も email も無い異常な行でも落ちない", () => {
    const view = buildGuestListView([{ responseStatus: "accepted" }]);
    expect(view?.guests[0]?.label).toBe("(不明な参加者)");
  });

  it("displayName の無い会議室はメールで出す", () => {
    const view = buildGuestListView([
      { email: "room-x@resource.calendar.google.com", resource: true },
    ]);
    expect(view?.rooms).toEqual(["room-x@resource.calendar.google.com"]);
  });

  it("応答状態が無い行は未返信として数える", () => {
    const view = buildGuestListView([{ email: "a@example.com" }]);
    expect(view?.guests[0]?.responseStatus).toBe("needsAction");
    expect(view?.summaryLabel).toBe("未返信 1");
  });

  it("応答状態が全種類そろっていても、参加→未定→不参加→未返信の順で内訳を出す", () => {
    const view = buildGuestListView([
      { email: "d@example.com", responseStatus: "needsAction" },
      { email: "c@example.com", responseStatus: "declined" },
      { email: "b@example.com", responseStatus: "tentative" },
      { email: "a@example.com", responseStatus: "accepted" },
    ]);
    expect(view?.summaryLabel).toBe("参加 1・未定 1・不参加 1・未返信 1");
    // 並びは応答状態では動かさない(元の順のまま)
    expect(view?.guests.map((g) => g.label)).toEqual([
      "d@example.com",
      "c@example.com",
      "b@example.com",
      "a@example.com",
    ]);
  });

  it("0人の区分は内訳に出さない", () => {
    const view = buildGuestListView([
      { email: "a@example.com", responseStatus: "accepted" },
      { email: "b@example.com", responseStatus: "accepted" },
    ]);
    expect(view?.summaryLabel).toBe("参加 2");
  });

  it("数十人でも数え上げは正しく、畳む行数の判断に使える形で返る", () => {
    const view = buildGuestListView(manyGuests(48));
    expect(view?.countLabel).toBe("ゲスト 48人");
    expect(view?.summaryLabel).toBe("未返信 48");
    expect(view?.guests).toHaveLength(48);
    // 畳んだ状態で見えるのは先頭 GUEST_PREVIEW_COUNT 件だけ (残りは開くと出る)
    expect(view!.guests.slice(0, GUEST_PREVIEW_COUNT)).toHaveLength(GUEST_PREVIEW_COUNT);
  });

  it("一覧が打ち切られていれば人数を断定せず「〜人以上」と出す", () => {
    const view = buildGuestListView(manyGuests(50), true);
    expect(view?.countLabel).toBe("ゲスト 50人以上");
  });

  it("同じ表示名が並んでも key は衝突しない", () => {
    const view = buildGuestListView([
      { displayName: "同姓同名" },
      { displayName: "同姓同名" },
    ]);
    expect(view?.guests[0]?.key).not.toBe(view?.guests[1]?.key);
  });
});

/**
 * ゲストの追加・削除 (2026-07-31) が使う2項目。表示の判断と同じデータしか見ないので
 * この層に置いてある (詳細は guestList.ts の guestRemovalBlockReason 参照)。
 */
describe("guestRemovalBlockReason", () => {
  it("普通のゲストは外せる", () => {
    expect(guestRemovalBlockReason({ email: "a@example.com" })).toBeNull();
  });

  it("自分自身は外せない (出たくないなら不参加、無くしたいなら予定ごと削除)", () => {
    expect(guestRemovalBlockReason({ email: "me@example.com", self: true })).toBe("self");
  });

  it("主催者は外せない", () => {
    expect(guestRemovalBlockReason({ email: "lead@example.com", organizer: true })).toBe(
      "organizer",
    );
  });

  it("会議室・機材は外せない (人ではないのでこの欄では扱わない)", () => {
    expect(guestRemovalBlockReason({ email: "room@resource.calendar.google.com", resource: true }))
      .toBe("resource");
  });

  it("アドレスの分からない行は外せない (要求の宛先が無い)", () => {
    expect(guestRemovalBlockReason({ displayName: "名前だけ" })).toBe("noEmail");
  });

  it("自分かつ会議室のような矛盾した行は resource を先に見る", () => {
    expect(guestRemovalBlockReason({ email: "x@example.com", self: true, resource: true })).toBe(
      "resource",
    );
  });
});

describe("GuestRow の email / removable", () => {
  it("普通のゲストには email が付き removable が立つ", () => {
    const view = buildGuestListView([
      { email: "me@example.com", self: true },
      { email: "sato@example.com", displayName: "佐藤 悠" },
    ]);
    expect(view?.guests[1]).toMatchObject({ email: "sato@example.com", removable: true });
  });

  it("自分・主催者の行は removable が false", () => {
    const view = buildGuestListView([
      { email: "me@example.com", self: true },
      { email: "lead@example.com", organizer: true },
    ]);
    expect(view?.guests.every((g) => g.removable === false)).toBe(true);
  });

  it("表示名しか無い行は email を持たず removable も false", () => {
    const view = buildGuestListView([{ displayName: "名前だけ" }]);
    expect(view?.guests[0]).not.toHaveProperty("email");
    expect(view?.guests[0].removable).toBe(false);
  });

  it("会議室は人の一覧に入らないので removable の判断対象にならない", () => {
    const view = buildGuestListView([
      { email: "me@example.com", self: true },
      { email: "room@resource.calendar.google.com", displayName: "会議室A", resource: true },
    ]);
    expect(view?.guests).toHaveLength(1);
    expect(view?.rooms).toEqual(["会議室A"]);
  });
});
