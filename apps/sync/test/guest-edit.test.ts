import { describe, expect, it } from "vite-plus/test";
import {
  applyGuestChanges,
  guestEmailKey,
  isRemovableGuest,
  isValidEventGuestsRequest,
} from "../src/core/guest-edit";
import type { RawAttendee } from "../src/google/rsvp-raw";

const BASE = {
  accountId: "acct-1",
  calendarId: "primary",
  eventId: "event-1",
};

const me: RawAttendee = {
  email: "me@example.com",
  self: true,
  organizer: true,
  responseStatus: "accepted",
};
const other: RawAttendee = {
  email: "sato@example.com",
  displayName: "佐藤 悠",
  responseStatus: "tentative",
  comment: "遅れます",
};
const room: RawAttendee = {
  email: "room-a@resource.calendar.google.com",
  displayName: "会議室A",
  resource: true,
  responseStatus: "accepted",
};

describe("isValidEventGuestsRequest", () => {
  it("accepts an add-only request", () => {
    expect(isValidEventGuestsRequest({ ...BASE, addEmails: ["a@example.com"] })).toBe(true);
  });

  it("accepts a remove-only request", () => {
    expect(isValidEventGuestsRequest({ ...BASE, removeEmails: ["a@example.com"] })).toBe(true);
  });

  it("accepts add and remove together", () => {
    expect(
      isValidEventGuestsRequest({
        ...BASE,
        addEmails: ["a@example.com"],
        removeEmails: ["b@example.com"],
      }),
    ).toBe(true);
  });

  it("rejects a request that changes nothing (both lists empty or absent)", () => {
    expect(isValidEventGuestsRequest({ ...BASE })).toBe(false);
    expect(isValidEventGuestsRequest({ ...BASE, addEmails: [], removeEmails: [] })).toBe(false);
  });

  it("rejects missing/blank identifiers", () => {
    for (const key of ["accountId", "calendarId", "eventId"] as const) {
      expect(isValidEventGuestsRequest({ ...BASE, [key]: "", addEmails: ["a@example.com"] })).toBe(
        false,
      );
      const without = { ...BASE, addEmails: ["a@example.com"] } as Record<string, unknown>;
      delete without[key];
      expect(isValidEventGuestsRequest(without)).toBe(false);
    }
  });

  it("rejects non-object bodies", () => {
    expect(isValidEventGuestsRequest(null)).toBe(false);
    expect(isValidEventGuestsRequest(undefined)).toBe(false);
    expect(isValidEventGuestsRequest("a@example.com")).toBe(false);
    expect(isValidEventGuestsRequest(42)).toBe(false);
  });

  it("rejects lists that are not arrays of usable email strings", () => {
    expect(isValidEventGuestsRequest({ ...BASE, addEmails: "a@example.com" })).toBe(false);
    expect(isValidEventGuestsRequest({ ...BASE, addEmails: [123] })).toBe(false);
    expect(isValidEventGuestsRequest({ ...BASE, addEmails: [""] })).toBe(false);
    // @ を含まない文字列は宛先になり得ない
    expect(isValidEventGuestsRequest({ ...BASE, addEmails: ["not-an-email"] })).toBe(false);
    // 空白・カンマ・セミコロンは「複数まとめて貼り付けた」形なので弾く
    expect(isValidEventGuestsRequest({ ...BASE, addEmails: ["a@example.com b@example.com"] })).toBe(
      false,
    );
    expect(isValidEventGuestsRequest({ ...BASE, addEmails: ["a@example.com,b@example.com"] })).toBe(
      false,
    );
    expect(isValidEventGuestsRequest({ ...BASE, removeEmails: [null] })).toBe(false);
  });

  it("rejects an address longer than 254 characters", () => {
    expect(
      isValidEventGuestsRequest({ ...BASE, addEmails: [`${"a".repeat(250)}@example.com`] }),
    ).toBe(false);
  });

  it("rejects more than 50 addresses in one request", () => {
    const many = Array.from({ length: 51 }, (_, i) => `m${i}@example.com`);
    expect(isValidEventGuestsRequest({ ...BASE, addEmails: many })).toBe(false);
    expect(
      isValidEventGuestsRequest({
        ...BASE,
        addEmails: many.slice(0, 26),
        removeEmails: many.slice(0, 25),
      }),
    ).toBe(false);
    expect(isValidEventGuestsRequest({ ...BASE, addEmails: many.slice(0, 50) })).toBe(true);
  });
});

describe("isRemovableGuest", () => {
  it("allows a plain guest", () => {
    expect(isRemovableGuest(other)).toBe(true);
  });

  it("refuses self, the organizer and resources (rooms/equipment)", () => {
    expect(isRemovableGuest(me)).toBe(false);
    expect(isRemovableGuest({ email: "lead@example.com", organizer: true })).toBe(false);
    expect(isRemovableGuest(room)).toBe(false);
  });
});

describe("guestEmailKey", () => {
  it("normalizes case and surrounding whitespace", () => {
    expect(guestEmailKey("  Sato@Example.COM ")).toBe("sato@example.com");
  });
});

describe("applyGuestChanges", () => {
  it("appends added guests with only an email (Google fills in needsAction itself)", () => {
    const result = applyGuestChanges([me, other], { addEmails: ["new@example.com"] });

    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.next).toEqual([me, other, { email: "new@example.com" }]);
    // 追加行に responseStatus を自分で書かない (公式の警告: accepted 等で足すと
    // 招待設定によっては needsAction に戻され、予定が現れないことがある)
    expect(result.next[2]).not.toHaveProperty("responseStatus");
  });

  it("adds the first guest to an event that had none", () => {
    const result = applyGuestChanges([], { addEmails: ["first@example.com"] });

    expect(result.next).toEqual([{ email: "first@example.com" }]);
    expect(result.added).toBe(1);
  });

  it("keeps every field of the existing entries (the array is fully replaced)", () => {
    const result = applyGuestChanges([me, other], { addEmails: ["new@example.com"] });

    // comment / displayName / responseStatus など、読んでいないフィールドも落とさない
    expect(result.next[1]).toBe(other);
    expect(result.next[1]).toHaveProperty("comment", "遅れます");
  });

  it("removes a guest, matching the address case-insensitively", () => {
    const result = applyGuestChanges([me, other], { removeEmails: ["SATO@EXAMPLE.COM"] });

    expect(result.next).toEqual([me]);
    expect(result.removed).toBe(1);
  });

  it("never removes self, the organizer or a room even when asked", () => {
    const organizerOnly: RawAttendee = { email: "lead@example.com", organizer: true };
    const result = applyGuestChanges([me, organizerOnly, room, other], {
      removeEmails: [me.email!, organizerOnly.email!, room.email!, other.email!],
    });

    expect(result.next).toEqual([me, organizerOnly, room]);
    expect(result.removed).toBe(1);
  });

  it("does not add someone who is already on the list (case-insensitive)", () => {
    const result = applyGuestChanges([me, other], { addEmails: ["Sato@Example.com"] });

    expect(result.next).toEqual([me, other]);
    expect(result.added).toBe(0);
  });

  it("collapses duplicates inside a single request", () => {
    const result = applyGuestChanges([], {
      addEmails: ["dup@example.com", "DUP@example.com", " dup@example.com "],
    });

    expect(result.next).toEqual([{ email: "dup@example.com" }]);
    expect(result.added).toBe(1);
  });

  it("applies add and remove in one pass", () => {
    const result = applyGuestChanges([me, other], {
      addEmails: ["new@example.com"],
      removeEmails: ["sato@example.com"],
    });

    expect(result.next).toEqual([me, { email: "new@example.com" }]);
    expect(result).toMatchObject({ added: 1, removed: 1 });
  });

  it("re-adding the address being removed in the same request keeps it (removed then added back)", () => {
    const result = applyGuestChanges([me, other], {
      addEmails: ["sato@example.com"],
      removeEmails: ["sato@example.com"],
    });

    // 元の行 (displayName/responseStatus 付き) は失われ、素の email だけの行に戻る。
    // 意味のある操作ではないが、一覧から人が消えないことだけは保証する
    expect(result.next.map((a) => a.email)).toEqual(["me@example.com", "sato@example.com"]);
  });

  it("leaves entries without an email untouched", () => {
    const nameless: RawAttendee = { displayName: "名前だけ" };
    const result = applyGuestChanges([nameless, other], { removeEmails: ["sato@example.com"] });

    expect(result.next).toEqual([nameless]);
  });

  it("ignores blank entries in the add list", () => {
    const result = applyGuestChanges([me], { addEmails: ["", "   "] });

    expect(result.next).toEqual([me]);
    expect(result.added).toBe(0);
  });

  it("reports no change when nothing matched (the caller then skips the PATCH)", () => {
    const result = applyGuestChanges([me, other], { removeEmails: ["ghost@example.com"] });

    expect(result).toMatchObject({ added: 0, removed: 0 });
    expect(result.next).toEqual([me, other]);
  });

  it("handles a large attendee list without reordering the survivors", () => {
    const crowd: RawAttendee[] = Array.from({ length: 300 }, (_, i) => ({
      email: `m${i}@example.com`,
      responseStatus: "needsAction",
    }));
    const result = applyGuestChanges([me, ...crowd], {
      addEmails: ["extra@example.com"],
      removeEmails: ["m0@example.com", "m299@example.com"],
    });

    expect(result).toMatchObject({ added: 1, removed: 2 });
    expect(result.next).toHaveLength(300);
    expect(result.next[0]).toBe(me);
    expect(result.next[1].email).toBe("m1@example.com");
    expect(result.next[result.next.length - 1]).toEqual({ email: "extra@example.com" });
  });
});
