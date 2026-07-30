import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_REMINDER_LEAD_MINUTES,
  formatReminderBody,
  getNotifiedKeys,
  getReminderLeadMinutes,
  isReminderTarget,
  normalizeReminderLead,
  parseReminderKeyStartMs,
  pruneNotifiedKeys,
  REMINDER_LEAD_OFF,
  reminderKey,
  selectDueReminders,
  setNotifiedKeys,
  setReminderLeadMinutes,
  type ReminderCandidate,
} from "./reminderSchedule";
import type { StorageLike } from "../layout/localStore";

/** localStore.ts の StorageLike フェイク (useMediaQuery.test.ts と同じ「注入して window を要らなくする」流儀) */
function fakeStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

const TZ = "Asia/Tokyo";

/** 2026-07-30T14:00:00+09:00 を基準時刻に使う */
const START_14 = Date.UTC(2026, 6, 30, 5, 0, 0);
const MIN = 60_000;

function candidate(overrides: Partial<ReminderCandidate> = {}): ReminderCandidate {
  return { id: "g:acc:cal@group.calendar.google.com:evt", title: "定例", startMs: START_14, ...overrides };
}

describe("reminderKey / parseReminderKeyStartMs", () => {
  it("開始時刻をキーに埋め込むので、同じ予定でも時刻が変われば別のキーになる", () => {
    const moved = reminderKey("g:acc:cal:evt", START_14 + 30 * MIN);
    expect(reminderKey("g:acc:cal:evt", START_14)).not.toBe(moved);
  });

  it("id に @ を含む (Google の calendarId はメール形式) キーでも開始時刻を復元できる", () => {
    const id = "g:acc:abc@group.calendar.google.com:evt";
    expect(parseReminderKeyStartMs(reminderKey(id, START_14))).toBe(START_14);
  });

  it("@ が無い/数値でない壊れたキーは null", () => {
    expect(parseReminderKeyStartMs("no-separator")).toBeNull();
    expect(parseReminderKeyStartMs("id@notanumber")).toBeNull();
  });
});

describe("isReminderTarget", () => {
  it("普通の予定は対象", () => {
    expect(isReminderTarget(candidate())).toBe(true);
    expect(isReminderTarget(candidate({ responseStatus: "accepted" }))).toBe(true);
    expect(isReminderTarget(candidate({ responseStatus: "needsAction" }))).toBe(true);
  });

  it("カレンダーブロックの複製は実体と二重に通知しないため対象外", () => {
    expect(isReminderTarget(candidate({ isMirror: true }))).toBe(false);
  });

  it("勤務場所は予定ではないので対象外", () => {
    expect(isReminderTarget(candidate({ isWorkingLocation: true }))).toBe(false);
  });

  it("欠席と答えた予定は対象外", () => {
    expect(isReminderTarget(candidate({ responseStatus: "declined" }))).toBe(false);
  });
});

describe("selectDueReminders", () => {
  const notified = new Set<string>();

  it("通知時刻ちょうど (start - lead === now) で通知する", () => {
    const due = selectDueReminders({
      candidates: [candidate()],
      nowMs: START_14 - 10 * MIN,
      leadMinutes: 10,
      notified,
      timeZone: TZ,
    });
    expect(due).toHaveLength(1);
    expect(due[0]?.title).toBe("定例");
  });

  it("通知時刻の1分前 (まだ達していない) では通知しない", () => {
    const due = selectDueReminders({
      candidates: [candidate()],
      nowMs: START_14 - 11 * MIN,
      leadMinutes: 10,
      notified,
      timeZone: TZ,
    });
    expect(due).toEqual([]);
  });

  it("直前 (通知時刻を過ぎているがまだ開始前) なら通知する ―― 起動直後でも取りこぼさない", () => {
    const due = selectDueReminders({
      candidates: [candidate()],
      nowMs: START_14 - 1 * MIN,
      leadMinutes: 10,
      notified,
      timeZone: TZ,
    });
    expect(due).toHaveLength(1);
    expect(due[0]?.body).toBe("14:00 開始 · あと 1 分");
  });

  it("開始時刻ちょうど・過去の予定には通知しない (起動時に過去分が一気に飛ぶ事故の防止)", () => {
    for (const nowMs of [START_14, START_14 + 1 * MIN, START_14 + 60 * MIN]) {
      expect(
        selectDueReminders({
          candidates: [candidate()],
          nowMs,
          leadMinutes: 10,
          notified,
          timeZone: TZ,
        }),
      ).toEqual([]);
    }
  });

  it("1週間アプリを落としていた後に起動しても、過去の予定は1件も出ない", () => {
    const week = 7 * 24 * 60 * MIN;
    const past = [
      candidate({ id: "a", startMs: START_14 - week }),
      candidate({ id: "b", startMs: START_14 - 3 * 60 * MIN }),
      candidate({ id: "c", startMs: START_14 - 1 * MIN }),
    ];
    const soon = candidate({ id: "d", startMs: START_14 + 5 * MIN });
    const due = selectDueReminders({
      candidates: [...past, soon],
      nowMs: START_14,
      leadMinutes: 10,
      notified,
      timeZone: TZ,
    });
    expect(due.map((d) => d.key)).toEqual([reminderKey("d", START_14 + 5 * MIN)]);
  });

  it("通知済みのキーは二度と出さない (リロード・再同期・ウィンドウ開閉を跨いだ二重通知の防止)", () => {
    const c = candidate();
    const nowMs = START_14 - 10 * MIN;
    const args = { candidates: [c], nowMs, leadMinutes: 10, notified: new Set<string>(), timeZone: TZ };
    const first = selectDueReminders(args);
    expect(first).toHaveLength(1);

    const after = selectDueReminders({ ...args, notified: new Set([first[0]!.key]) });
    expect(after).toEqual([]);
  });

  it("移動後は通知済み集合に旧キーが残っていても改めて通知する", () => {
    const oldKey = reminderKey("evt", START_14);
    const moved = candidate({ id: "evt", startMs: START_14 + 60 * MIN });
    const due = selectDueReminders({
      candidates: [moved],
      nowMs: moved.startMs - 10 * MIN,
      leadMinutes: 10,
      notified: new Set([oldKey]),
      timeZone: TZ,
    });
    expect(due).toHaveLength(1);
    expect(due[0]?.key).toBe(reminderKey("evt", moved.startMs));
  });

  it("削除された予定は候補に現れないので通知も止まる", () => {
    // 「削除」= applySync が occurrences から消す = candidates に入ってこない、という表現
    const due = selectDueReminders({
      candidates: [],
      nowMs: START_14 - 10 * MIN,
      leadMinutes: 10,
      notified,
      timeZone: TZ,
    });
    expect(due).toEqual([]);
  });

  it("終日予定は対象外 ―― startMs を持たない形が混ざっても弾く", () => {
    // AllDayOccurrence (model/types.ts) は startMs/endMs を持たず startDate/endDate だけ。
    // 呼び出し側は allDayStore を読まないので本来渡ってこないが、渡っても
    // 「NaN 分前」のような通知にならないことを保証する。
    const allDayShaped = { id: "g:acc:cal:allday", title: "祝日", startDate: "2026-07-30" };
    expect(isReminderTarget(allDayShaped as unknown as ReminderCandidate)).toBe(false);
    expect(
      selectDueReminders({
        candidates: [allDayShaped as unknown as ReminderCandidate],
        nowMs: START_14,
        leadMinutes: 10,
        notified,
        timeZone: TZ,
      }),
    ).toEqual([]);
  });

  it("オフ (leadMinutes = 0) では何も出さない", () => {
    expect(
      selectDueReminders({
        candidates: [candidate()],
        nowMs: START_14 - 1 * MIN,
        leadMinutes: REMINDER_LEAD_OFF,
        notified,
        timeZone: TZ,
      }),
    ).toEqual([]);
  });

  it("複数件は開始時刻順に返す", () => {
    const due = selectDueReminders({
      candidates: [
        candidate({ id: "late", startMs: START_14 + 9 * MIN }),
        candidate({ id: "early", startMs: START_14 + 2 * MIN }),
      ],
      nowMs: START_14,
      leadMinutes: 10,
      notified,
      timeZone: TZ,
    });
    expect(due.map((d) => d.startMs)).toEqual([START_14 + 2 * MIN, START_14 + 9 * MIN]);
  });

  it("タイトルが空の予定でも通知の見出しが空にならない", () => {
    const due = selectDueReminders({
      candidates: [candidate({ title: "   " })],
      nowMs: START_14 - 5 * MIN,
      leadMinutes: 10,
      notified,
      timeZone: TZ,
    });
    expect(due[0]?.title).toBe("(タイトルなし)");
  });
});

describe("formatReminderBody", () => {
  it("開始時刻はタイムゾーンで表示する", () => {
    expect(formatReminderBody(START_14, START_14 - 10 * MIN, "Asia/Tokyo")).toBe(
      "14:00 開始 · あと 10 分",
    );
    expect(formatReminderBody(START_14, START_14 - 10 * MIN, "UTC")).toBe("05:00 開始 · あと 10 分");
  });

  it("残り 1 分未満は「まもなく」", () => {
    expect(formatReminderBody(START_14, START_14 - 10_000, TZ)).toBe("14:00 開始 · まもなく");
  });
});

describe("pruneNotifiedKeys", () => {
  it("保持期間より古い開始時刻のキーを捨て、新しいものは残す", () => {
    const fresh = reminderKey("fresh", START_14);
    const old = reminderKey("old", START_14 - 48 * 60 * MIN);
    const kept = pruneNotifiedKeys(new Set([fresh, old]), START_14 + MIN);
    expect([...kept]).toEqual([fresh]);
  });

  it("壊れたキーも掃除する", () => {
    const kept = pruneNotifiedKeys(new Set(["broken", reminderKey("ok", START_14)]), START_14);
    expect([...kept]).toEqual([reminderKey("ok", START_14)]);
  });

  it("未来の予定のキーは当然残る (通知直後に prune が走っても消えない)", () => {
    const key = reminderKey("soon", START_14 + 10 * MIN);
    expect([...pruneNotifiedKeys(new Set([key]), START_14)]).toEqual([key]);
  });
});

describe("設定の永続化", () => {
  it("保存が無ければ既定の 10 分", () => {
    expect(getReminderLeadMinutes(fakeStorage())).toBe(DEFAULT_REMINDER_LEAD_MINUTES);
  });

  it("保存した値を読み戻せる。0 (通知しない) も有効な保存値", () => {
    const storage = fakeStorage();
    setReminderLeadMinutes(30, storage);
    expect(getReminderLeadMinutes(storage)).toBe(30);
    setReminderLeadMinutes(REMINDER_LEAD_OFF, storage);
    expect(getReminderLeadMinutes(storage)).toBe(REMINDER_LEAD_OFF);
  });

  it("プリセットに無い値・壊れた値は既定に落ちる", () => {
    expect(normalizeReminderLead("7")).toBeNull();
    expect(normalizeReminderLead("abc")).toBeNull();
    expect(normalizeReminderLead("10.5")).toBeNull();
    expect(getReminderLeadMinutes(fakeStorage({ "kichijitsu:reminderLead": "999" }))).toBe(
      DEFAULT_REMINDER_LEAD_MINUTES,
    );
  });

  it("通知済み集合はリロードを跨いで読み戻せる", () => {
    const storage = fakeStorage();
    const key = reminderKey("evt", START_14);
    setNotifiedKeys(new Set([key]), storage);
    expect(getNotifiedKeys(storage).has(key)).toBe(true);
  });

  it("localStorage が使えない環境 (保存が全部落ちる) でも既定値で動く", () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error("disabled");
      },
      setItem: () => {
        throw new Error("disabled");
      },
      removeItem: () => {},
    };
    expect(getReminderLeadMinutes(broken)).toBe(DEFAULT_REMINDER_LEAD_MINUTES);
    expect(getNotifiedKeys(broken).size).toBe(0);
    expect(() => setNotifiedKeys(new Set(["x"]), broken)).not.toThrow();
  });
});
