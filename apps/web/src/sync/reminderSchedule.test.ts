import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_REMINDER_MODE,
  formatReminderBody,
  getNotifiedKeys,
  getReminderMode,
  isReminderTarget,
  MAX_HONORED_LEAD_MINUTES,
  parseReminderKeyStartMs,
  parseReminderMode,
  pruneNotifiedKeys,
  REMINDER_CATCHUP_MS,
  REMINDER_LOOKAHEAD_MS,
  REMINDER_TICK_MS,
  reminderKey,
  resolveLeadMinutes,
  selectDueReminders,
  serializeReminderMode,
  setNotifiedKeys,
  setReminderMode,
  type CalendarDefaultReminders,
  type ReminderCandidate,
  type ReminderMode,
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

/** 「Google の設定に従う」— 今回の既定 */
const GOOGLE: ReminderMode = { kind: "google" };
/** 旧来の「一律◯分前」 */
const fixed = (minutes: number): ReminderMode => ({ kind: "fixed", minutes });

function candidate(overrides: Partial<ReminderCandidate> = {}): ReminderCandidate {
  return {
    id: "g:acc:cal@group.calendar.google.com:evt",
    title: "定例",
    startMs: START_14,
    // 既定モード (google) のテストで毎回書かずに済むよう、既定は「10分前が1件」にしておく
    reminders: { minutes: [10] },
    ...overrides,
  };
}

/** カレンダー既定の lookup。キーは calendarKey(accountId, calendarId) と同じ規則 */
function defaults(entries: Record<string, number[]>): CalendarDefaultReminders {
  return new Map(Object.entries(entries));
}

describe("reminderKey / parseReminderKeyStartMs", () => {
  it("開始時刻をキーに埋め込むので、同じ予定でも時刻が変われば別のキーになる", () => {
    const moved = reminderKey("g:acc:cal:evt", START_14 + 30 * MIN, 10);
    expect(reminderKey("g:acc:cal:evt", START_14, 10)).not.toBe(moved);
  });

  it("分数もキーに含めるので、同じ予定の複数リマインダーが潰し合わない", () => {
    expect(reminderKey("evt", START_14, 60)).not.toBe(reminderKey("evt", START_14, 10));
  });

  it("id に @ を含む (Google の calendarId はメール形式) キーでも開始時刻を復元できる", () => {
    const id = "g:acc:abc@group.calendar.google.com:evt";
    expect(parseReminderKeyStartMs(reminderKey(id, START_14, 10))).toBe(START_14);
  });

  it("旧形式 (分数なし) のキーからも開始時刻を復元できる ―― prune が既存の保存を捨てない", () => {
    expect(parseReminderKeyStartMs(`g:acc:cal@x.com:evt@${START_14}`)).toBe(START_14);
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

describe("resolveLeadMinutes", () => {
  it("予定に直接設定された分数をそのまま使う", () => {
    expect(resolveLeadMinutes(candidate({ reminders: { minutes: [30] } }), GOOGLE)).toEqual([30]);
  });

  it("複数のリマインダーは全部返す (Google では1予定に最大5件設定できる)", () => {
    const c = candidate({ reminders: { minutes: [60, 10, 1440] } });
    expect(resolveLeadMinutes(c, GOOGLE)).toEqual([10, 60, 1440]);
  });

  it("重複は1件に潰す (同じ時刻に2回鳴らさない)", () => {
    expect(resolveLeadMinutes(candidate({ reminders: { minutes: [10, 10] } }), GOOGLE)).toEqual([
      10,
    ]);
  });

  it("リマインダー未設定 (空配列) は通知しない ―― 一律の分数で勝手に補わない", () => {
    expect(resolveLeadMinutes(candidate({ reminders: { minutes: [] } }), GOOGLE)).toEqual([]);
  });

  it("0 分 (開始時刻ちょうど) は有効な設定として残す", () => {
    expect(resolveLeadMinutes(candidate({ reminders: { minutes: [0] } }), GOOGLE)).toEqual([0]);
  });

  it("上限 (1日) を超える分数は落とす。丸めずに落とすのは、設定していない時刻に鳴らさないため", () => {
    const c = candidate({
      reminders: { minutes: [10, MAX_HONORED_LEAD_MINUTES, MAX_HONORED_LEAD_MINUTES + 1, 40320] },
    });
    expect(resolveLeadMinutes(c, GOOGLE)).toEqual([10, MAX_HONORED_LEAD_MINUTES]);
  });

  it("負の分数・非整数は落とす (Google が返さないはずの異常値を通さない)", () => {
    const c = candidate({ reminders: { minutes: [-5, 10.5, 10] } });
    expect(resolveLeadMinutes(c, GOOGLE)).toEqual([10]);
  });

  it("useDefault はカレンダーの既定リマインダーから解決する", () => {
    const c = candidate({
      reminders: { useDefault: true },
      accountId: "acc",
      calendarId: "cal@group.calendar.google.com",
    });
    expect(
      resolveLeadMinutes(c, GOOGLE, defaults({ "acc:cal@group.calendar.google.com": [15, 60] })),
    ).toEqual([15, 60]);
  });

  it("useDefault でカレンダー既定が空 (祝日カレンダー等) なら通知しない", () => {
    const c = candidate({ reminders: { useDefault: true }, accountId: "acc", calendarId: "cal" });
    expect(resolveLeadMinutes(c, GOOGLE, defaults({ "acc:cal": [] }))).toEqual([]);
  });

  it("useDefault でカレンダー一覧が未取得なら通知しない (起動直後に誤った時刻で鳴らさない)", () => {
    const c = candidate({ reminders: { useDefault: true }, accountId: "acc", calendarId: "cal" });
    expect(resolveLeadMinutes(c, GOOGLE, undefined)).toEqual([]);
    expect(resolveLeadMinutes(c, GOOGLE, defaults({}))).toEqual([]);
  });

  it("reminders 未同期 (世代7のバックフィル前) はカレンダー既定として扱う", () => {
    // 「バックフィルが終わるまで通知が全部止まる」という一番驚く壊れ方を避けるための扱い。
    // Google 上の予定の大多数が実際に useDefault なので、これが最も近い推測になる。
    const c = candidate({ reminders: undefined, accountId: "acc", calendarId: "cal" });
    expect(resolveLeadMinutes(c, GOOGLE, defaults({ "acc:cal": [10] }))).toEqual([10]);
  });

  it("Google 由来でない予定 (アカウント/カレンダーを持たない) は結局通知しない", () => {
    const c = candidate({ reminders: undefined, accountId: undefined, calendarId: undefined });
    expect(resolveLeadMinutes(c, GOOGLE, defaults({ "acc:cal": [10] }))).toEqual([]);
  });

  it("一律モードは Google 側の設定を一切見ない", () => {
    const c = candidate({
      reminders: { minutes: [] },
      accountId: "acc",
      calendarId: "cal",
    });
    expect(resolveLeadMinutes(c, fixed(30), defaults({ "acc:cal": [60] }))).toEqual([30]);
  });

  it("オフはどんな設定でも空", () => {
    const c = candidate({ reminders: { minutes: [5, 10] } });
    expect(resolveLeadMinutes(c, { kind: "off" })).toEqual([]);
  });
});

describe("selectDueReminders", () => {
  const notified = new Set<string>();
  const base = { notified, timeZone: TZ, mode: GOOGLE };

  it("通知時刻ちょうど (start - lead === now) で通知する", () => {
    const due = selectDueReminders({
      ...base,
      candidates: [candidate()],
      nowMs: START_14 - 10 * MIN,
    });
    expect(due).toHaveLength(1);
    expect(due[0]?.title).toBe("定例");
    expect(due[0]?.leadMinutes).toBe(10);
  });

  it("通知時刻の1分前 (まだ達していない) では通知しない", () => {
    expect(
      selectDueReminders({ ...base, candidates: [candidate()], nowMs: START_14 - 11 * MIN }),
    ).toEqual([]);
  });

  it("直前 (通知時刻を過ぎているがまだ開始前) なら通知する ―― 起動直後でも取りこぼさない", () => {
    const due = selectDueReminders({
      ...base,
      candidates: [candidate()],
      nowMs: START_14 - 1 * MIN,
    });
    expect(due).toHaveLength(1);
    expect(due[0]?.body).toBe("14:00 開始 · あと 1 分");
  });

  it("開始時刻ちょうど・過去の予定には通知しない (起動時に過去分が一気に飛ぶ事故の防止)", () => {
    for (const nowMs of [START_14, START_14 + 1 * MIN, START_14 + 60 * MIN]) {
      expect(selectDueReminders({ ...base, candidates: [candidate()], nowMs })).toEqual([]);
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
    const due = selectDueReminders({ ...base, candidates: [...past, soon], nowMs: START_14 });
    expect(due.map((d) => d.key)).toEqual([reminderKey("d", START_14 + 5 * MIN, 10)]);
  });

  it("通知済みのキーは二度と出さない (リロード・再同期・ウィンドウ開閉を跨いだ二重通知の防止)", () => {
    const args = {
      ...base,
      candidates: [candidate()],
      nowMs: START_14 - 10 * MIN,
      notified: new Set<string>(),
    };
    const first = selectDueReminders(args);
    expect(first).toHaveLength(1);
    expect(selectDueReminders({ ...args, notified: new Set([first[0]!.key]) })).toEqual([]);
  });

  it("移動後は通知済み集合に旧キーが残っていても改めて通知する", () => {
    const moved = candidate({ id: "evt", startMs: START_14 + 60 * MIN });
    const due = selectDueReminders({
      ...base,
      candidates: [moved],
      nowMs: moved.startMs - 10 * MIN,
      notified: new Set([reminderKey("evt", START_14, 10)]),
    });
    expect(due).toHaveLength(1);
    expect(due[0]?.key).toBe(reminderKey("evt", moved.startMs, 10));
  });

  it("削除された予定は候補に現れないので通知も止まる", () => {
    // 「削除」= applySync が occurrences から消す = candidates に入ってこない、という表現
    expect(selectDueReminders({ ...base, candidates: [], nowMs: START_14 - 10 * MIN })).toEqual([]);
  });

  it("終日予定は対象外 ―― startMs を持たない形が混ざっても弾く", () => {
    // AllDayOccurrence (model/types.ts) は startMs/endMs を持たず startDate/endDate だけ。
    // そもそも reminders も持たせていない (通知の対象外なので model 層にも足していない)。
    const allDayShaped = { id: "g:acc:cal:allday", title: "祝日", startDate: "2026-07-30" };
    expect(isReminderTarget(allDayShaped as unknown as ReminderCandidate)).toBe(false);
    expect(
      selectDueReminders({
        ...base,
        candidates: [allDayShaped as unknown as ReminderCandidate],
        nowMs: START_14,
      }),
    ).toEqual([]);
  });

  it("オフでは何も出さない", () => {
    expect(
      selectDueReminders({
        ...base,
        mode: { kind: "off" },
        candidates: [candidate()],
        nowMs: START_14 - 1 * MIN,
      }),
    ).toEqual([]);
  });

  it("複数件は開始時刻順に返す", () => {
    const due = selectDueReminders({
      ...base,
      candidates: [
        candidate({ id: "late", startMs: START_14 + 9 * MIN }),
        candidate({ id: "early", startMs: START_14 + 2 * MIN }),
      ],
      nowMs: START_14,
    });
    expect(due.map((d) => d.startMs)).toEqual([START_14 + 2 * MIN, START_14 + 9 * MIN]);
  });

  it("タイトルが空の予定でも通知の見出しが空にならない", () => {
    const due = selectDueReminders({
      ...base,
      candidates: [candidate({ title: "   " })],
      nowMs: START_14 - 5 * MIN,
    });
    expect(due[0]?.title).toBe("(タイトルなし)");
  });

  describe("1つの予定に複数のリマインダー", () => {
    const multi = candidate({ id: "evt", reminders: { minutes: [10, 60] } });

    it("それぞれの時刻で別々に通知する", () => {
      const early = selectDueReminders({ ...base, candidates: [multi], nowMs: START_14 - 60 * MIN });
      expect(early.map((d) => d.leadMinutes)).toEqual([60]);
      expect(early[0]?.body).toBe("14:00 開始 · あと 60 分");

      // 60 分前ぶんを通知済みにしても、10 分前ぶんはちゃんと出る (キーに分数を含めた理由)
      const late = selectDueReminders({
        ...base,
        candidates: [multi],
        nowMs: START_14 - 10 * MIN,
        notified: new Set([early[0]!.key]),
      });
      expect(late.map((d) => d.leadMinutes)).toEqual([10]);
    });

    it("同じ tick で2件立った場合は短いほう (差し迫っているほう) を後に並べる", () => {
      const c = candidate({ id: "evt", startMs: START_14, reminders: { minutes: [10, 12] } });
      const due = selectDueReminders({ ...base, candidates: [c], nowMs: START_14 - 10 * MIN });
      expect(due.map((d) => d.leadMinutes)).toEqual([10, 12]);
    });
  });

  describe("0 分 (開始時刻ちょうど) のリマインダー", () => {
    const atStart = candidate({ reminders: { minutes: [0] } });

    it("開始の直前 (1 tick 以内) に出る ―― 窓が潰れて永久に出ない、にならない", () => {
      const due = selectDueReminders({
        ...base,
        candidates: [atStart],
        nowMs: START_14 - REMINDER_TICK_MS,
      });
      expect(due).toHaveLength(1);
      expect(due[0]?.leadMinutes).toBe(0);
      // 開始まで 30 秒を切っていれば本文は「まもなく」になる
      expect(
        selectDueReminders({ ...base, candidates: [atStart], nowMs: START_14 - 10_000 })[0]?.body,
      ).toBe("14:00 開始 · まもなく");
    });

    it("1 tick より前には出ない", () => {
      expect(
        selectDueReminders({
          ...base,
          candidates: [atStart],
          nowMs: START_14 - REMINDER_TICK_MS - 1,
        }),
      ).toEqual([]);
    });

    it("開始してしまえば出ない", () => {
      expect(selectDueReminders({ ...base, candidates: [atStart], nowMs: START_14 })).toEqual([]);
    });
  });

  describe("遅れすぎた通知は出さない (REMINDER_CATCHUP_MS)", () => {
    it("1日前のリマインダーは、起動が遅れると出ない ―― 起動直後の一斉通知の抑止", () => {
      const c = candidate({ startMs: START_14, reminders: { minutes: [1440] } });
      const fireAt = START_14 - 1440 * MIN;
      expect(
        selectDueReminders({ ...base, candidates: [c], nowMs: fireAt + REMINDER_CATCHUP_MS }),
      ).toHaveLength(1);
      expect(
        selectDueReminders({ ...base, candidates: [c], nowMs: fireAt + REMINDER_CATCHUP_MS + 1 }),
      ).toEqual([]);
    });

    it("15 分以内のリマインダーでは一度も効かない ―― 既存利用者の見え方を変えないため", () => {
      // 判定窓 (fireAt〜開始) の幅がそもそも猶予より狭いので、開始前である限り必ず通る
      for (const lead of [5, 10, 15]) {
        const c = candidate({ reminders: { minutes: [lead] } });
        for (const nowMs of [START_14 - lead * MIN, START_14 - 1]) {
          expect(selectDueReminders({ ...base, candidates: [c], nowMs })).toHaveLength(1);
        }
      }
    });
  });

  describe("カレンダー既定との組み合わせ", () => {
    it("useDefault の予定はカレンダーごとに別の分数で通知する", () => {
      const work = candidate({
        id: "work",
        reminders: { useDefault: true },
        accountId: "acc",
        calendarId: "work",
      });
      const holiday = candidate({
        id: "holiday",
        reminders: { useDefault: true },
        accountId: "acc",
        calendarId: "holiday",
      });
      const args = {
        ...base,
        candidates: [work, holiday],
        calendarDefaults: defaults({ "acc:work": [30], "acc:holiday": [] }),
      };
      expect(selectDueReminders({ ...args, nowMs: START_14 - 30 * MIN }).map((d) => d.key)).toEqual([
        reminderKey("work", START_14, 30),
      ]);
      // 既定が空のカレンダーは、いつ判定しても出ない
      expect(selectDueReminders({ ...args, nowMs: START_14 - 1 * MIN })).toEqual([]);
    });
  });
});

describe("REMINDER_LOOKAHEAD_MS", () => {
  it("尊重する最大のリマインダーを必ず含む (先読みが足りずに取りこぼさない)", () => {
    expect(REMINDER_LOOKAHEAD_MS).toBeGreaterThan(MAX_HONORED_LEAD_MINUTES * MIN);
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
    const fresh = reminderKey("fresh", START_14, 10);
    const old = reminderKey("old", START_14 - 48 * 60 * MIN, 10);
    const kept = pruneNotifiedKeys(new Set([fresh, old]), START_14 + MIN);
    expect([...kept]).toEqual([fresh]);
  });

  it("壊れたキーも掃除する", () => {
    const ok = reminderKey("ok", START_14, 10);
    expect([...pruneNotifiedKeys(new Set(["broken", ok]), START_14)]).toEqual([ok]);
  });

  it("未来の予定のキーは当然残る (通知直後に prune が走っても消えない)", () => {
    const key = reminderKey("soon", START_14 + 10 * MIN, 10);
    expect([...pruneNotifiedKeys(new Set([key]), START_14)]).toEqual([key]);
  });
});

describe("設定の永続化", () => {
  it("保存が無ければ既定は「Google の設定に従う」", () => {
    expect(getReminderMode(fakeStorage())).toEqual(DEFAULT_REMINDER_MODE);
    expect(getReminderMode(fakeStorage())).toEqual({ kind: "google" });
  });

  it("選んだモードを読み戻せる", () => {
    const storage = fakeStorage();
    for (const mode of [fixed(30), { kind: "off" } as ReminderMode, GOOGLE]) {
      setReminderMode(mode, storage);
      expect(getReminderMode(storage)).toEqual(mode);
    }
  });

  it("旧形式 (数字だけ) の保存を引き継ぐ ―― 自分で分数を選んでいた人はそのまま", () => {
    // 2026-07-30 の初版はこのキーに "0"/"5"/"10"/"15"/"30"/"60" を書いていた
    expect(parseReminderMode("0")).toEqual({ kind: "off" });
    expect(parseReminderMode("30")).toEqual({ kind: "fixed", minutes: 30 });
    // "10" は初版の既定値。設定画面を触らずにいた人にも書かれていた値なので、
    // 旧形式のうちここだけは特に読めなくなると影響が大きい
    expect(getReminderMode(fakeStorage({ "kichijitsu:reminderLead": "10" }))).toEqual({
      kind: "fixed",
      minutes: 10,
    });
  });

  it("プリセットに無い値・壊れた値は既定 (Google に従う) に落ちる", () => {
    expect(parseReminderMode("7")).toBeNull();
    expect(parseReminderMode("abc")).toBeNull();
    expect(parseReminderMode("10.5")).toBeNull();
    expect(getReminderMode(fakeStorage({ "kichijitsu:reminderLead": "999" }))).toEqual(
      DEFAULT_REMINDER_MODE,
    );
  });

  it("serialize / parse は往復する (select の value に使うため)", () => {
    for (const mode of [GOOGLE, { kind: "off" } as ReminderMode, fixed(60)]) {
      expect(parseReminderMode(serializeReminderMode(mode))).toEqual(mode);
    }
  });

  it("通知済み集合はリロードを跨いで読み戻せる", () => {
    const storage = fakeStorage();
    const key = reminderKey("evt", START_14, 10);
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
    expect(getReminderMode(broken)).toEqual(DEFAULT_REMINDER_MODE);
    expect(getNotifiedKeys(broken).size).toBe(0);
    expect(() => setNotifiedKeys(new Set(["x"]), broken)).not.toThrow();
  });
});
