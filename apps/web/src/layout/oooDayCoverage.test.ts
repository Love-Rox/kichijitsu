import { describe, expect, it } from "vite-plus/test";
import { Temporal } from "@js-temporal/polyfill";
import type { Occurrence } from "../model/types";
import type { OccurrenceGroup } from "./groupDuplicates";
import {
  coversWholeDay,
  coveredDayRange,
  dayCoveringOooAllDayGroups,
  splitDayCoveringOooGroups,
} from "./oooDayCoverage";

const TZ = "Asia/Tokyo";

/** ローカル日時文字列 → epoch ms。テストの意図(現地時刻)をそのまま書けるようにする */
function ms(iso: string, timeZone = TZ): number {
  return Temporal.PlainDateTime.from(iso).toZonedDateTime(timeZone).epochMilliseconds;
}

function day(iso: string): Temporal.PlainDate {
  return Temporal.PlainDate.from(iso);
}

function occ(overrides: Partial<Occurrence> = {}): Occurrence {
  return {
    id: "g:acc-1:cal-1:evt-1",
    seriesId: null,
    title: "法定外休日",
    startMs: ms("2026-07-25T00:00"),
    endMs: ms("2026-07-26T00:00"),
    color: "#ef4444",
    source: "google",
    accountId: "acc-1",
    calendarId: "cal-1",
    isOutOfOffice: true,
    ...overrides,
  };
}

function group(primary: Occurrence): OccurrenceGroup {
  return { primary, members: [primary] };
}

describe("coversWholeDay", () => {
  it("実データの形 (dateTime で 0:00–24:00) はその日を丸ごと覆う", () => {
    // 利用者の実データそのまま: 法定外休日 2026-07-25T00:00+09:00 → 2026-07-26T00:00+09:00
    const range = { startMs: ms("2026-07-25T00:00"), endMs: ms("2026-07-26T00:00") };
    expect(coversWholeDay(range, day("2026-07-25"), TZ)).toBe(true);
  });

  it("終了が翌日 0:00 ちょうどでも、翌日は覆わない(オフバイワンの境界)", () => {
    const range = { startMs: ms("2026-07-25T00:00"), endMs: ms("2026-07-26T00:00") };
    expect(coversWholeDay(range, day("2026-07-26"), TZ)).toBe(false);
  });

  it("開始日の前日も覆わない", () => {
    const range = { startMs: ms("2026-07-25T00:00"), endMs: ms("2026-07-26T00:00") };
    expect(coversWholeDay(range, day("2026-07-24"), TZ)).toBe(false);
  });

  it("複数日を覆う不在は、間の日をすべて丸ごと覆う(終端の翌日は覆わない)", () => {
    // 7/25 00:00 → 7/27 00:00 なら 7/25 と 7/26 の2日ともが「丸ごと覆われた日」
    const range = { startMs: ms("2026-07-25T00:00"), endMs: ms("2026-07-27T00:00") };
    expect(coversWholeDay(range, day("2026-07-25"), TZ)).toBe(true);
    expect(coversWholeDay(range, day("2026-07-26"), TZ)).toBe(true);
    expect(coversWholeDay(range, day("2026-07-27"), TZ)).toBe(false);
  });

  it("丸ごとではない不在 (9:00–18:00) はどの日も覆わない ―― 通常の不在はレールのまま", () => {
    const range = { startMs: ms("2026-07-25T09:00"), endMs: ms("2026-07-25T18:00") };
    expect(coversWholeDay(range, day("2026-07-25"), TZ)).toBe(false);
  });

  it("1分でも欠けたら覆わない(0:01 開始 / 23:59 終了)", () => {
    expect(
      coversWholeDay(
        { startMs: ms("2026-07-25T00:01"), endMs: ms("2026-07-26T00:00") },
        day("2026-07-25"),
        TZ,
      ),
    ).toBe(false);
    expect(
      coversWholeDay(
        { startMs: ms("2026-07-25T00:00"), endMs: ms("2026-07-25T23:59") },
        day("2026-07-25"),
        TZ,
      ),
    ).toBe(false);
  });

  it("日をはみ出して覆う不在も、丸ごと覆っている日は true", () => {
    // 7/24 15:00 → 7/28 09:00: 7/25〜7/27 は丸ごと、7/24 と 7/28 は一部だけ
    const range = { startMs: ms("2026-07-24T15:00"), endMs: ms("2026-07-28T09:00") };
    expect(coversWholeDay(range, day("2026-07-24"), TZ)).toBe(false);
    expect(coversWholeDay(range, day("2026-07-25"), TZ)).toBe(true);
    expect(coversWholeDay(range, day("2026-07-27"), TZ)).toBe(true);
    expect(coversWholeDay(range, day("2026-07-28"), TZ)).toBe(false);
  });

  it("判定は表示タイムゾーンでの1日で行う(同じ instant でも tz が違えば結果が変わる)", () => {
    // +09:00 の 0:00–24:00 は UTC では 7/24 15:00 → 7/25 15:00 で、どの UTC 日も丸ごとにならない
    const range = { startMs: ms("2026-07-25T00:00"), endMs: ms("2026-07-26T00:00") };
    expect(coversWholeDay(range, day("2026-07-24"), "UTC")).toBe(false);
    expect(coversWholeDay(range, day("2026-07-25"), "UTC")).toBe(false);
  });

  it("DST で23時間しかない日でも、その日の 0:00–24:00 なら丸ごと覆う", () => {
    // America/New_York の 2026-03-08 は夏時間開始で23時間しかない
    const tz = "America/New_York";
    const range = { startMs: ms("2026-03-08T00:00", tz), endMs: ms("2026-03-09T00:00", tz) };
    expect(coversWholeDay(range, day("2026-03-08"), tz)).toBe(true);
    // 24時間ぶんの ms を足しただけの区間は「翌日の 0:00」を1時間追い越すが、当日はやはり丸ごと
    const naive = { startMs: range.startMs, endMs: range.startMs + 24 * 60 * 60_000 };
    expect(coversWholeDay(naive, day("2026-03-08"), tz)).toBe(true);
    expect(coversWholeDay(naive, day("2026-03-09"), tz)).toBe(false);
  });

  it("DST で25時間ある日は、24時間ぶんでは丸ごとにならない", () => {
    // America/New_York の 2026-11-01 は夏時間終了で25時間ある
    const tz = "America/New_York";
    const start = ms("2026-11-01T00:00", tz);
    expect(
      coversWholeDay({ startMs: start, endMs: start + 24 * 60 * 60_000 }, day("2026-11-01"), tz),
    ).toBe(false);
    expect(
      coversWholeDay({ startMs: start, endMs: ms("2026-11-02T00:00", tz) }, day("2026-11-01"), tz),
    ).toBe(true);
  });
});

describe("coveredDayRange", () => {
  it("0:00–24:00 の1日ぶんは、その1日だけの範囲になる", () => {
    expect(
      coveredDayRange({ startMs: ms("2026-07-25T00:00"), endMs: ms("2026-07-26T00:00") }, TZ),
    ).toEqual({ startDate: "2026-07-25", endDate: "2026-07-25" });
  });

  it("複数日を覆う不在は、両端 inclusive の連続範囲になる(終端の翌日は含まない)", () => {
    expect(
      coveredDayRange({ startMs: ms("2026-07-25T00:00"), endMs: ms("2026-07-27T00:00") }, TZ),
    ).toEqual({
      startDate: "2026-07-25",
      endDate: "2026-07-26",
    });
  });

  it("丸ごと覆う日が1日も無ければ null", () => {
    expect(
      coveredDayRange({ startMs: ms("2026-07-25T09:00"), endMs: ms("2026-07-25T18:00") }, TZ),
    ).toBeNull();
    // 日はまたぐが、どの日も丸ごとではない
    expect(
      coveredDayRange({ startMs: ms("2026-07-25T09:00"), endMs: ms("2026-07-26T09:00") }, TZ),
    ).toBeNull();
  });

  it("端が半端でも、丸ごとの日だけを切り出す", () => {
    expect(
      coveredDayRange({ startMs: ms("2026-07-24T15:00"), endMs: ms("2026-07-28T09:00") }, TZ),
    ).toEqual({
      startDate: "2026-07-25",
      endDate: "2026-07-27",
    });
  });

  it("coversWholeDay と結果が一致する(日単位の判定と範囲の作り方がズレていないこと)", () => {
    const ranges = [
      { startMs: ms("2026-07-25T00:00"), endMs: ms("2026-07-26T00:00") },
      { startMs: ms("2026-07-25T00:00"), endMs: ms("2026-07-27T00:00") },
      { startMs: ms("2026-07-24T15:00"), endMs: ms("2026-07-28T09:00") },
      { startMs: ms("2026-07-25T09:00"), endMs: ms("2026-07-25T18:00") },
      { startMs: ms("2026-07-25T09:00"), endMs: ms("2026-07-26T09:00") },
      { startMs: ms("2026-07-25T00:00"), endMs: ms("2026-07-25T23:59") },
    ];
    for (const range of ranges) {
      const covered = coveredDayRange(range, TZ);
      // 前後に余裕を持たせた窓を1日ずつ舐め、coversWholeDay の集合と一致することを確かめる
      const expected: string[] = [];
      for (
        let d = day("2026-07-22");
        Temporal.PlainDate.compare(d, day("2026-07-31")) <= 0;
        d = d.add({ days: 1 })
      ) {
        if (coversWholeDay(range, d, TZ)) expected.push(d.toString());
      }
      const actual: string[] = [];
      if (covered) {
        for (
          let d = Temporal.PlainDate.from(covered.startDate);
          Temporal.PlainDate.compare(d, Temporal.PlainDate.from(covered.endDate)) <= 0;
          d = d.add({ days: 1 })
        ) {
          actual.push(d.toString());
        }
      }
      expect(actual).toEqual(expected);
    }
  });
});

describe("splitDayCoveringOooGroups", () => {
  const covering = group(occ({ id: "ooo-covering" }));
  const partial = group(
    occ({ id: "ooo-partial", startMs: ms("2026-07-25T09:00"), endMs: ms("2026-07-25T18:00") }),
  );

  it("既定(引数省略 = timeline)は1件も動かさない ―― 既存の見え方を変えないため", () => {
    const { railGroups, dayCoveringGroups } = splitDayCoveringOooGroups(
      [covering, partial],
      day("2026-07-25"),
      TZ,
    );
    expect(railGroups).toEqual([covering, partial]);
    expect(dayCoveringGroups).toEqual([]);
  });

  it('placement="timeline" を明示しても同じ', () => {
    const { railGroups, dayCoveringGroups } = splitDayCoveringOooGroups(
      [covering, partial],
      day("2026-07-25"),
      TZ,
      "timeline",
    );
    expect(railGroups).toEqual([covering, partial]);
    expect(dayCoveringGroups).toEqual([]);
  });

  it('placement="allday" では、その日を丸ごと覆うものだけをレールから外す', () => {
    const { railGroups, dayCoveringGroups } = splitDayCoveringOooGroups(
      [covering, partial],
      day("2026-07-25"),
      TZ,
      "allday",
    );
    expect(railGroups).toEqual([partial]);
    expect(dayCoveringGroups).toEqual([covering]);
  });

  it("判定は日ごと: 一部の日だけを丸ごと覆う不在は、丸ごとでない日はレールに残る", () => {
    const spanning = group(
      occ({ id: "ooo-spanning", startMs: ms("2026-07-24T15:00"), endMs: ms("2026-07-28T09:00") }),
    );
    expect(
      splitDayCoveringOooGroups([spanning], day("2026-07-24"), TZ, "allday").railGroups,
    ).toEqual([spanning]);
    expect(
      splitDayCoveringOooGroups([spanning], day("2026-07-25"), TZ, "allday").railGroups,
    ).toEqual([]);
  });
});

describe("dayCoveringOooAllDayGroups", () => {
  it("既定(timeline)では常に空 ―― 終日欄には1件も出さない", () => {
    expect(dayCoveringOooAllDayGroups([group(occ())], TZ)).toEqual([]);
    expect(dayCoveringOooAllDayGroups([group(occ())], TZ, "timeline")).toEqual([]);
  });

  it("不在でない予定は、1日を丸ごと覆っていても対象外", () => {
    const normal = group(occ({ id: "normal", isOutOfOffice: undefined }));
    expect(dayCoveringOooAllDayGroups([normal], TZ, "allday")).toEqual([]);
  });

  it("丸ごとではない不在 (9:00–18:00) は対象外", () => {
    const partial = group(
      occ({ id: "ooo-partial", startMs: ms("2026-07-25T09:00"), endMs: ms("2026-07-25T18:00") }),
    );
    expect(dayCoveringOooAllDayGroups([partial], TZ, "allday")).toEqual([]);
  });

  it("0:00–24:00 の不在を、その日1日ぶんの終日予定へ射影する", () => {
    const [g] = dayCoveringOooAllDayGroups([group(occ())], TZ, "allday");
    expect(g.primary.startDate).toBe("2026-07-25");
    expect(g.primary.endDate).toBe("2026-07-25");
    expect(g.primary.isOutOfOffice).toBe(true);
    expect(g.primary.title).toBe("法定外休日");
    expect(g.primary.id).toBe("g:acc-1:cal-1:evt-1");
    expect(g.members).toEqual([g.primary]);
  });

  it("複数日を覆う不在は、複数日にまたがる1本のバーになる(終日バーの日付範囲は両端 inclusive)", () => {
    const spanning = group(
      occ({ id: "ooo-span", startMs: ms("2026-07-25T00:00"), endMs: ms("2026-07-27T00:00") }),
    );
    const [g] = dayCoveringOooAllDayGroups([spanning], TZ, "allday");
    expect(g.primary.startDate).toBe("2026-07-25");
    expect(g.primary.endDate).toBe("2026-07-26");
  });

  it("射影した終日予定は時刻フィールドを一切持たない(時刻予定として誤認されないため)", () => {
    const [g] = dayCoveringOooAllDayGroups([group(occ({ originalStartMs: 123 }))], TZ, "allday");
    expect("startMs" in g.primary).toBe(false);
    expect("endMs" in g.primary).toBe(false);
    expect("originalStartMs" in g.primary).toBe(false);
  });

  it("集約グループのメンバーも同じ日付範囲へ射影する(所属カレンダーの内訳が消えない)", () => {
    const a = occ({ id: "copy-a", accountId: "acc-1", iCalUID: "uid-1" });
    const b = occ({ id: "copy-b", accountId: "acc-2", iCalUID: "uid-1" });
    const [g] = dayCoveringOooAllDayGroups([{ primary: a, members: [a, b] }], TZ, "allday");
    expect(g.members.map((m) => m.id)).toEqual(["copy-a", "copy-b"]);
    expect(g.members.every((m) => m.startDate === "2026-07-25")).toBe(true);
  });

  it("色・カレンダー・説明などの表示に要る情報を保つ", () => {
    const source = occ({
      hasCustomColor: true,
      location: "自宅",
      description: "終日不在です",
      conferenceUrl: "https://example.com/meet",
    });
    const [g] = dayCoveringOooAllDayGroups([group(source)], TZ, "allday");
    expect(g.primary.color).toBe("#ef4444");
    expect(g.primary.hasCustomColor).toBe(true);
    expect(g.primary.accountId).toBe("acc-1");
    expect(g.primary.calendarId).toBe("cal-1");
    expect(g.primary.location).toBe("自宅");
    expect(g.primary.description).toBe("終日不在です");
    expect(g.primary.conferenceUrl).toBe("https://example.com/meet");
  });

  it("入力順を保つ(終日レーンの行割り当て packDayBars は入力順に依存するため)", () => {
    const first = group(occ({ id: "ooo-1" }));
    const second = group(
      occ({ id: "ooo-2", startMs: ms("2026-07-26T00:00"), endMs: ms("2026-07-27T00:00") }),
    );
    expect(
      dayCoveringOooAllDayGroups([first, second], TZ, "allday").map((g) => g.primary.id),
    ).toEqual(["ooo-1", "ooo-2"]);
  });
});
