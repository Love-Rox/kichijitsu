import { describe, expect, it, vi } from "vite-plus/test";
import { planFollowingSplit, type RawSeriesEvent } from "../src/core/guest-following-plan";
import { editGuestsFollowingWithRetry } from "../src/core/guest-following";
import { GoogleApiError, NotOrganizerError, SplitUnsupportedError } from "../src/core/errors";

const MASTER_ID = "series1";
const TARGET_ID = "series1_20261124T190000Z";

const master: RawSeriesEvent = {
  id: MASTER_ID,
  iCalUID: "series1@google.com",
  summary: "週次の定例",
  location: "会議室A",
  colorId: "5",
  organizer: { self: true },
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
  start: { dateTime: "2026-11-10T04:00:00+09:00", timeZone: "Asia/Tokyo" },
  end: { dateTime: "2026-11-10T04:30:00+09:00", timeZone: "Asia/Tokyo" },
  attendees: [
    { email: "me@example.com", self: true, organizer: true, responseStatus: "accepted" },
    { email: "sato@example.com", displayName: "佐藤", responseStatus: "tentative" },
  ],
};

const instance: RawSeriesEvent = {
  id: TARGET_ID,
  recurringEventId: MASTER_ID,
  organizer: { self: true },
  originalStartTime: { dateTime: "2026-11-24T04:00:00+09:00" },
  start: { dateTime: "2026-11-24T04:00:00+09:00", timeZone: "Asia/Tokyo" },
  end: { dateTime: "2026-11-24T04:30:00+09:00", timeZone: "Asia/Tokyo" },
};

function plan(over: Partial<Parameters<typeof planFollowingSplit>[0]> = {}) {
  return planFollowingSplit({
    instance,
    master,
    exceptions: [],
    change: { addEmails: ["new@example.com"] },
    ...over,
  });
}

describe("planFollowingSplit", () => {
  it("対象の回の直前で親を打ち切り、新シリーズは対象の回から始める", () => {
    const p = plan();
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    // 2026-11-24T04:00+09:00 = 2026-11-23T19:00:00Z の 1 秒前
    expect(p.truncatedRecurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261123T185959Z"]);
    expect(p.newEventBody.start).toEqual(instance.start);
    expect(p.newEventBody.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=TU"]);
    expect(p.newEventBody.summary).toBe("週次の定例");
    expect(p.newEventBody.location).toBe("会議室A");
    expect(p.newEventBody.colorId).toBe("5");
  });

  it("ゲストの差分は新シリーズにだけ反映し、返事は引き継がない(主催者は承諾済み)", () => {
    const p = plan();
    if (!p.ok) throw new Error("expected ok");
    expect(p.newEventBody.attendees).toEqual([
      { email: "me@example.com", responseStatus: "accepted" },
      { email: "sato@example.com", displayName: "佐藤" },
      { email: "new@example.com" },
    ]);
  });

  it("既存の UNTIL は置き換える", () => {
    const p = plan({
      master: { ...master, recurrence: ["RRULE:FREQ=WEEKLY;UNTIL=20271231T000000Z"] },
    });
    if (!p.ok) throw new Error("expected ok");
    expect(p.truncatedRecurrence).toEqual(["RRULE:FREQ=WEEKLY;UNTIL=20261123T185959Z"]);
    // 新シリーズは元の終わり(UNTIL)を保つ
    expect(p.newEventBody.recurrence).toEqual(["RRULE:FREQ=WEEKLY;UNTIL=20271231T000000Z"]);
  });

  it("対象の回以降に削除した回があれば EXDATE で新シリーズへ写す(それより前は写さない)", () => {
    const p = plan({
      exceptions: [
        { status: "cancelled", originalStartTime: { dateTime: "2026-12-08T04:00:00+09:00" } },
        { status: "cancelled", originalStartTime: { dateTime: "2026-11-17T04:00:00+09:00" } },
      ],
    });
    if (!p.ok) throw new Error("expected ok");
    expect(p.newEventBody.recurrence).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=TU",
      "EXDATE:20261207T190000Z",
    ]);
  });

  it("終日の繰り返しは日付で打ち切る", () => {
    const allDayMaster: RawSeriesEvent = {
      ...master,
      start: { date: "2026-11-10" },
      end: { date: "2026-11-11" },
    };
    const allDayInstance: RawSeriesEvent = {
      ...instance,
      originalStartTime: { date: "2026-11-24" },
      start: { date: "2026-11-24" },
      end: { date: "2026-11-25" },
    };
    const p = plan({ master: allDayMaster, instance: allDayInstance });
    if (!p.ok) throw new Error("expected ok");
    expect(p.truncatedRecurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261123"]);
  });

  it("Meet の会議情報があれば新シリーズへ写す", () => {
    const p = plan({
      master: {
        ...master,
        conferenceData: { conferenceId: "abc-defg-hij", entryPoints: [{ uri: "https://meet.google.com/abc-defg-hij" }] },
      },
    });
    if (!p.ok) throw new Error("expected ok");
    expect(p.copiesConference).toBe(true);
    expect(p.newEventBody.conferenceData).toMatchObject({ conferenceId: "abc-defg-hij" });
  });

  it("主催者でなければ NotOrganizerError(何も書かない)", () => {
    expect(() => plan({ master: { ...master, organizer: { self: false } } })).toThrow(
      NotOrganizerError,
    );
  });

  it.each([
    ["COUNT で終わる繰り返し", { recurrence: ["RRULE:FREQ=WEEKLY;COUNT=10"] }, "count_rule"],
    ["EXDATE を含む繰り返し", { recurrence: ["RRULE:FREQ=WEEKLY", "EXDATE:20261201T190000Z"] }, "complex_recurrence"],
    ["通常以外の予定", { eventType: "outOfOffice" }, "unsupported_type"],
  ])("断る: %s", (_label, masterOver, reason) => {
    const p = plan({ master: { ...master, ...masterOver } });
    expect(p).toEqual({ ok: false, reason });
  });

  it("断る: 最初の回(「すべての予定」を使う)", () => {
    const first: RawSeriesEvent = {
      ...instance,
      originalStartTime: { dateTime: "2026-11-10T04:00:00+09:00" },
    };
    expect(plan({ instance: first })).toEqual({ ok: false, reason: "first_instance" });
  });

  it("断る: 対象の回以降に個別に変更した回がある", () => {
    const p = plan({
      exceptions: [
        { status: "confirmed", originalStartTime: { dateTime: "2026-12-01T04:00:00+09:00" } },
      ],
    });
    expect(p).toEqual({ ok: false, reason: "has_future_exceptions" });
  });

  it("対象の回より前の個別変更は気にしない", () => {
    const p = plan({
      exceptions: [
        { status: "confirmed", originalStartTime: { dateTime: "2026-11-17T04:00:00+09:00" } },
      ],
    });
    expect(p.ok).toBe(true);
  });

  it("差分が何も効かないときは no_change", () => {
    expect(plan({ change: { addEmails: ["sato@example.com"] } })).toEqual({
      ok: false,
      reason: "no_change",
    });
  });
});

// ---- 書き込みの順序と巻き戻し ----

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

/** URL とメソッドで応答を決めるフェイク Google。呼び出しの記録つき */
function fakeGoogle(handlers: {
  insert?: () => Response;
  patch?: () => Response;
  list?: () => Response;
}) {
  const calls: Call[] = [];
  const impl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET" && url.includes(`/events/${TARGET_ID}`)) return json(instance);
    if (method === "GET" && url.includes(`/events/${MASTER_ID}`)) return json(master);
    if (method === "GET") return handlers.list?.() ?? json({ items: [master] });
    if (method === "POST") return handlers.insert?.() ?? json({ id: "new-series" });
    if (method === "PATCH") return handlers.patch?.() ?? json({});
    if (method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`unexpected ${method} ${url}`);
  });
  return { impl, calls };
}

const deps = (fetchImpl: typeof fetch) => ({
  fetch: fetchImpl,
  getAccessToken: async () => "tok",
  forceRefreshAccessToken: async () => "tok2",
});

const params = { calendarId: "cal", eventId: TARGET_ID, addEmails: ["new@example.com"] };

describe("editGuestsFollowingWithRetry", () => {
  it("先に新シリーズを作り、そのあと親を打ち切る", async () => {
    const g = fakeGoogle({});
    const result = await editGuestsFollowingWithRetry(deps(g.impl), params);
    expect(result).toEqual({ noop: false, newEventId: "new-series", meetDropped: false });
    const writes = g.calls.filter((c) => c.method !== "GET").map((c) => c.method);
    expect(writes).toEqual(["POST", "PATCH"]);
    const patch = g.calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toContain(`/events/${MASTER_ID}`);
    expect(patch.url).toContain("sendUpdates=all");
    expect(patch.body).toEqual({ recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261123T185959Z"] });
  });

  it("親の打ち切りに失敗したら、作った新シリーズを消して元のエラーを投げる", async () => {
    const g = fakeGoogle({ patch: () => json({ error: "boom" }, 500) });
    await expect(editGuestsFollowingWithRetry(deps(g.impl), params)).rejects.toBeInstanceOf(
      GoogleApiError,
    );
    const del = g.calls.find((c) => c.method === "DELETE");
    expect(del?.url).toContain("/events/new-series");
  });

  it("新シリーズの作成に失敗したら、親には触れない", async () => {
    const g = fakeGoogle({ insert: () => json({ error: "bad" }, 403) });
    await expect(editGuestsFollowingWithRetry(deps(g.impl), params)).rejects.toBeInstanceOf(
      GoogleApiError,
    );
    expect(g.calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(g.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("Meet の複写が 400 で弾かれたら、Meet 無しでやり直して meetDropped を立てる", async () => {
    const withMeet = { ...master, conferenceData: { conferenceId: "abc-defg-hij" } };
    let inserts = 0;
    const calls: Call[] = [];
    const impl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "GET" && url.includes(`/events/${TARGET_ID}`)) return json(instance);
      if (method === "GET" && url.includes(`/events/${MASTER_ID}`)) return json(withMeet);
      if (method === "GET") return json({ items: [withMeet] });
      if (method === "POST") {
        inserts += 1;
        return inserts === 1 ? json({ error: "conference" }, 400) : json({ id: "new-series" });
      }
      return json({});
    });
    const result = await editGuestsFollowingWithRetry(deps(impl), params);
    expect(result.meetDropped).toBe(true);
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect((posts[1].body as Record<string, unknown>).conferenceData).toBeUndefined();
  });

  it("安全に分割できない予定は SplitUnsupportedError で、何も書かない", async () => {
    const g = fakeGoogle({
      list: () =>
        json({
          items: [
            master,
            {
              id: "series1_20261201T190000Z",
              recurringEventId: MASTER_ID,
              status: "confirmed",
              originalStartTime: { dateTime: "2026-12-01T04:00:00+09:00" },
            },
          ],
        }),
    });
    await expect(editGuestsFollowingWithRetry(deps(g.impl), params)).rejects.toEqual(
      expect.objectContaining({ reason: "has_future_exceptions" }),
    );
    expect(g.calls.every((c) => c.method === "GET")).toBe(true);
    expect(SplitUnsupportedError).toBeDefined();
  });

  it("差分が効かないなら何も書かずに noop", async () => {
    const g = fakeGoogle({});
    const result = await editGuestsFollowingWithRetry(deps(g.impl), {
      ...params,
      addEmails: ["sato@example.com"],
    });
    expect(result).toEqual({ noop: true, meetDropped: false });
    expect(g.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("シリーズの1回分でない予定は断る", async () => {
    const impl = vi.fn<typeof fetch>(async () => json({ id: "single", organizer: { self: true } }));
    await expect(editGuestsFollowingWithRetry(deps(impl), params)).rejects.toEqual(
      expect.objectContaining({ reason: "not_recurring" }),
    );
  });
});
