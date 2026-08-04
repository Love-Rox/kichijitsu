import { describe, expect, it } from "vite-plus/test";
import type { BlockMirrorScanEntry, OrphanMirrorDTO } from "@kichijitsu/shared";
import {
  applyCleanupResult,
  buildCleanupRequest,
  describeCleanupTargets,
  formatOrphanRange,
  groupOrphansByCalendar,
  orphanKey,
  orphanStartMs,
  resolveOrphanCalendarSummary,
  resolveSelectedOrphans,
  scanFailures,
  sortOrphansByStart,
} from "./blockMirrorCleanup";

function orphan(overrides: Partial<OrphanMirrorDTO> = {}): OrphanMirrorDTO {
  return {
    accountId: "acc-1",
    calendarId: "cal-a",
    eventId: "evt-1",
    start: { dateTime: "2026-07-20T09:00:00+09:00" },
    end: { dateTime: "2026-07-20T10:00:00+09:00" },
    ruleId: "rule-1",
    sourceEventId: "src-1",
    ...overrides,
  };
}

function scanEntry(overrides: Partial<BlockMirrorScanEntry> = {}): BlockMirrorScanEntry {
  return {
    accountId: "acc-1",
    calendarId: "cal-a",
    calendarSummary: "仕事",
    ok: true,
    ...overrides,
  };
}

describe("orphanKey", () => {
  it("accountId:calendarId:eventId を連結する", () => {
    expect(orphanKey({ accountId: "acc-1", calendarId: "cal-a", eventId: "evt-1" })).toBe(
      "acc-1:cal-a:evt-1",
    );
  });

  it("同じ eventId でも accountId/calendarId が違えば別キーになる", () => {
    const a = orphanKey({ accountId: "acc-1", calendarId: "cal-a", eventId: "evt-1" });
    const b = orphanKey({ accountId: "acc-2", calendarId: "cal-a", eventId: "evt-1" });
    expect(a).not.toBe(b);
  });
});

describe("orphanStartMs", () => {
  it("dateTime があればそれを使う", () => {
    expect(orphanStartMs({ dateTime: "2026-07-20T09:00:00Z" })).toBe(
      new Date("2026-07-20T09:00:00Z").getTime(),
    );
  });

  it("dateTime が無ければ date を使う", () => {
    expect(orphanStartMs({ date: "2026-07-20" })).toBe(new Date("2026-07-20").getTime());
  });

  it("どちらも無ければ 0", () => {
    expect(orphanStartMs({})).toBe(0);
  });
});

describe("sortOrphansByStart", () => {
  it("開始日時の昇順に並べ替える", () => {
    const late = orphan({ eventId: "late", start: { dateTime: "2026-07-21T09:00:00+09:00" } });
    const early = orphan({ eventId: "early", start: { dateTime: "2026-07-19T09:00:00+09:00" } });
    const mid = orphan({ eventId: "mid", start: { dateTime: "2026-07-20T09:00:00+09:00" } });
    expect(sortOrphansByStart([late, early, mid]).map((o) => o.eventId)).toEqual([
      "early",
      "mid",
      "late",
    ]);
  });

  it("引数の配列は変更しない", () => {
    const list = [orphan({ eventId: "b" }), orphan({ eventId: "a" })];
    const original = [...list];
    sortOrphansByStart(list);
    expect(list).toEqual(original);
  });
});

describe("groupOrphansByCalendar", () => {
  it("accountId+calendarId でグループ化し、各グループ内は日時昇順にする", () => {
    const scanned = [
      scanEntry({ accountId: "acc-1", calendarId: "cal-a", calendarSummary: "仕事" }),
      scanEntry({ accountId: "acc-2", calendarId: "cal-b", calendarSummary: "プライベート" }),
    ];
    const groups = groupOrphansByCalendar(
      [
        orphan({
          accountId: "acc-1",
          calendarId: "cal-a",
          eventId: "e2",
          start: { dateTime: "2026-07-21T09:00:00+09:00" },
        }),
        orphan({
          accountId: "acc-1",
          calendarId: "cal-a",
          eventId: "e1",
          start: { dateTime: "2026-07-20T09:00:00+09:00" },
        }),
        orphan({ accountId: "acc-2", calendarId: "cal-b", eventId: "e3" }),
      ],
      scanned,
    );

    expect(groups).toHaveLength(2);
    const work = groups.find((g) => g.calendarSummary === "仕事");
    expect(work?.orphans.map((o) => o.eventId)).toEqual(["e1", "e2"]);
  });

  it("グループの並びはカレンダー名の辞書順(ja)にする", () => {
    const scanned = [
      scanEntry({ accountId: "acc-1", calendarId: "cal-z", calendarSummary: "わ行" }),
      scanEntry({ accountId: "acc-1", calendarId: "cal-a", calendarSummary: "あ行" }),
    ];
    const groups = groupOrphansByCalendar(
      [
        orphan({ accountId: "acc-1", calendarId: "cal-z", eventId: "e1" }),
        orphan({ accountId: "acc-1", calendarId: "cal-a", eventId: "e2" }),
      ],
      scanned,
    );
    expect(groups.map((g) => g.calendarSummary)).toEqual(["あ行", "わ行"]);
  });

  it("空配列なら空配列を返す", () => {
    expect(groupOrphansByCalendar([], [])).toEqual([]);
  });
});

describe("scanFailures", () => {
  it("ok:false のカレンダーだけを返す", () => {
    const scanned: BlockMirrorScanEntry[] = [
      { accountId: "acc-1", calendarId: "cal-a", calendarSummary: "仕事", ok: true },
      { accountId: "acc-1", calendarId: "cal-b", calendarSummary: "個人", ok: false, error: "500" },
    ];
    expect(scanFailures(scanned)).toEqual([
      { accountId: "acc-1", calendarId: "cal-b", calendarSummary: "個人", ok: false, error: "500" },
    ]);
  });

  it("全て ok なら空配列", () => {
    const scanned: BlockMirrorScanEntry[] = [
      { accountId: "acc-1", calendarId: "cal-a", calendarSummary: "仕事", ok: true },
    ];
    expect(scanFailures(scanned)).toEqual([]);
  });
});

describe("resolveSelectedOrphans / buildCleanupRequest", () => {
  it("選択済みキーに対応する orphans だけを解決する", () => {
    const a = orphan({ eventId: "a" });
    const b = orphan({ eventId: "b" });
    const selected = resolveSelectedOrphans([a, b], new Set([orphanKey(a)]));
    expect(selected).toEqual([a]);
  });

  it("buildCleanupRequest は accountId/calendarId/eventId だけを詰める", () => {
    const selected = [orphan({ eventId: "a" }), orphan({ eventId: "b", calendarId: "cal-b" })];
    expect(buildCleanupRequest(selected)).toEqual({
      items: [
        { accountId: "acc-1", calendarId: "cal-a", eventId: "a" },
        { accountId: "acc-1", calendarId: "cal-b", eventId: "b" },
      ],
    });
  });
});

describe("describeCleanupTargets", () => {
  it("件数と対象カレンダー名(重複無し・名前順)を返す", () => {
    const scanned = [
      scanEntry({ accountId: "acc-1", calendarId: "cal-a", calendarSummary: "仕事" }),
      scanEntry({ accountId: "acc-1", calendarId: "cal-b", calendarSummary: "個人" }),
    ];
    const selected = [
      orphan({ eventId: "a", calendarId: "cal-b" }),
      orphan({ eventId: "b", calendarId: "cal-a" }),
      orphan({ eventId: "c", calendarId: "cal-b" }),
    ];
    expect(describeCleanupTargets(selected, scanned)).toEqual({
      count: 3,
      calendarSummaries: ["個人", "仕事"],
    });
  });

  it("選択が空なら count:0 / calendarSummaries:[]", () => {
    expect(describeCleanupTargets([], [])).toEqual({ count: 0, calendarSummaries: [] });
  });
});

describe("applyCleanupResult", () => {
  const scanned = [scanEntry({ accountId: "acc-1", calendarId: "cal-a", calendarSummary: "仕事" })];

  it("failed に載らなかった要求分を orphans から除く", () => {
    const a = orphan({ eventId: "a" });
    const b = orphan({ eventId: "b" });
    const c = orphan({ eventId: "c" });
    const { remaining, failedDetails } = applyCleanupResult(
      [a, b, c],
      [
        { accountId: "acc-1", calendarId: "cal-a", eventId: "a" },
        { accountId: "acc-1", calendarId: "cal-a", eventId: "b" },
      ],
      { deleted: 1, failed: [{ eventId: "b", reason: "404" }] },
      scanned,
    );
    expect(remaining.map((o) => o.eventId)).toEqual(["b", "c"]);
    expect(failedDetails).toEqual([{ eventId: "b", reason: "404", calendarSummary: "仕事" }]);
  });

  it("全件成功なら failed 分の orphans が全部消え、failedDetails は空", () => {
    const a = orphan({ eventId: "a" });
    const { remaining, failedDetails } = applyCleanupResult(
      [a],
      [{ accountId: "acc-1", calendarId: "cal-a", eventId: "a" }],
      { deleted: 1, failed: [] },
      scanned,
    );
    expect(remaining).toEqual([]);
    expect(failedDetails).toEqual([]);
  });

  it("要求していない orphans には影響しない", () => {
    const a = orphan({ eventId: "a" });
    const untouched = orphan({ eventId: "untouched" });
    const { remaining } = applyCleanupResult(
      [a, untouched],
      [{ accountId: "acc-1", calendarId: "cal-a", eventId: "a" }],
      { deleted: 1, failed: [] },
      scanned,
    );
    expect(remaining).toEqual([untouched]);
  });

  it("failed の calendarSummary が prevOrphans から見つからなければ「(カレンダー不明)」", () => {
    const { failedDetails } = applyCleanupResult(
      [],
      [{ accountId: "acc-1", calendarId: "cal-a", eventId: "ghost" }],
      { deleted: 0, failed: [{ eventId: "ghost", reason: "404" }] },
      scanned,
    );
    expect(failedDetails).toEqual([
      { eventId: "ghost", reason: "404", calendarSummary: "(カレンダー不明)" },
    ]);
  });
});

describe("resolveOrphanCalendarSummary", () => {
  const scanned = [scanEntry({ accountId: "acc-1", calendarId: "cal-a", calendarSummary: "仕事" })];

  it("scanned の同じ (accountId, calendarId) から引く", () => {
    expect(resolveOrphanCalendarSummary(orphan(), scanned)).toBe("仕事");
  });

  it("scanned にも見つからなければ calendarId をそのまま返す(resolveCalendarName と同じ流儀)", () => {
    expect(resolveOrphanCalendarSummary(orphan({ calendarId: "cal-unknown" }), scanned)).toBe(
      "cal-unknown",
    );
  });
});

describe("formatOrphanRange", () => {
  it("同日の時刻予定は「日付 開始–終了」の形にする", () => {
    const start = new Date("2026-07-20T09:00:00+09:00");
    const end = new Date("2026-07-20T10:00:00+09:00");
    const result = formatOrphanRange({
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    });
    const expected = `${start.toLocaleDateString("ja-JP")} ${start.toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
    })}–${end.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`;
    expect(result).toBe(expected);
  });

  it("日をまたぐ時刻予定は終了側にも日付を出す", () => {
    const start = new Date("2026-07-20T23:00:00+09:00");
    const end = new Date("2026-07-21T01:00:00+09:00");
    const result = formatOrphanRange({
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    });
    expect(result).toContain(end.toLocaleDateString("ja-JP"));
  });

  it("終日1日の予定は「日付（終日）」にする(end.date は翌日 exclusive)", () => {
    const result = formatOrphanRange({ start: { date: "2026-07-20" }, end: { date: "2026-07-21" } });
    const expected = `${new Date("2026-07-20T00:00:00").toLocaleDateString("ja-JP")}（終日）`;
    expect(result).toBe(expected);
  });

  it("終日複数日の予定は開始〜最終日(exclusive の前日)を出す", () => {
    const result = formatOrphanRange({ start: { date: "2026-07-20" }, end: { date: "2026-07-23" } });
    const startLabel = new Date("2026-07-20T00:00:00").toLocaleDateString("ja-JP");
    const lastDayLabel = new Date("2026-07-22T00:00:00").toLocaleDateString("ja-JP");
    expect(result).toBe(`${startLabel} 〜 ${lastDayLabel}（終日）`);
  });

  it("start/end とも情報が無ければ「(日時不明)」", () => {
    expect(formatOrphanRange({ start: {}, end: {} })).toBe("(日時不明)");
  });

  it("end.dateTime が無ければ開始のみ表示する", () => {
    const start = new Date("2026-07-20T09:00:00+09:00");
    const result = formatOrphanRange({ start: { dateTime: start.toISOString() }, end: {} });
    const expected = `${start.toLocaleDateString("ja-JP")} ${start.toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
    expect(result).toBe(expected);
  });
});
