import { describe, expect, it } from "vite-plus/test";
import { Temporal } from "@js-temporal/polyfill";
import {
  allDayRangeCoversDate,
  dayRangeMs,
  dayStartMs,
  MINUTES_PER_DAY,
  plainDateOfMs,
} from "./dayTime";

/**
 * 日境界の共有ヘルパのテスト(2026-07-31、横断レビュー B-4/B-5 でこのモジュールを新設した際に
 * 追加)。ここが崩れると、表示範囲の取得(viewRange/monthGrid)・不在の終日判定
 * (oooDayCoverage)・レールの全高帯(railItems)・編集フォームの日付欄(sync/eventEdit)が
 * **同時に** 壊れる ―― 集約したぶんだけ、境界をここで固定しておく必要がある。
 *
 * 特に押さえたいのは2点:
 *  1. 日の長さを Temporal に計算させていること(DST の 23h/25h の日で 24*60*60_000 に
 *     退化していないこと)。テストの流儀は oooDayCoverage.test.ts の DST ケースに揃えてある。
 *  2. allDayRangeCoversDate の「辞書順 = 日付順」という前提(2026-07-31 に
 *     Temporal.PlainDate.compare からこちらへ寄せたので、前提そのものを固定する)。
 */

const TZ = "Asia/Tokyo";

/** ローカル日時文字列 → epoch ms。テストの意図(現地時刻)をそのまま書けるようにする */
function ms(iso: string, timeZone = TZ): number {
  return Temporal.PlainDateTime.from(iso).toZonedDateTime(timeZone).epochMilliseconds;
}

function day(iso: string): Temporal.PlainDate {
  return Temporal.PlainDate.from(iso);
}

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

describe("MINUTES_PER_DAY", () => {
  it("1440分(レールの全高帯 [0, MINUTES_PER_DAY] の上端)", () => {
    // 二重宣言を1本にまとめた定数なので、値そのものを固定しておく
    // (ここがずれると不在の全高ラインと勤務場所の「地」が同時に狂う)
    expect(MINUTES_PER_DAY).toBe(1440);
  });
});

describe("dayStartMs", () => {
  it("その日の 0:00(壁時計)の epoch ms を返す", () => {
    expect(dayStartMs(day("2026-07-25"), TZ)).toBe(ms("2026-07-25T00:00"));
  });

  it("タイムゾーンが違えば同じ日付でも別の瞬間になる(+09:00 の 0:00 は UTC の前日 15:00)", () => {
    const tokyo = dayStartMs(day("2026-07-25"), TZ);
    const utc = dayStartMs(day("2026-07-25"), "UTC");
    expect(utc - tokyo).toBe(9 * HOUR_MS);
    expect(tokyo).toBe(ms("2026-07-24T15:00", "UTC"));
  });

  it("DST 開始日(23時間しかない日)の翌日との差は23時間", () => {
    // America/New_York の 2026-03-08 は夏時間開始で23時間しかない
    const tz = "America/New_York";
    expect(dayStartMs(day("2026-03-09"), tz) - dayStartMs(day("2026-03-08"), tz)).toBe(23 * HOUR_MS);
  });

  it("DST 終了日(25時間ある日)の翌日との差は25時間", () => {
    // America/New_York の 2026-11-01 は夏時間終了で25時間ある
    const tz = "America/New_York";
    expect(dayStartMs(day("2026-11-02"), tz) - dayStartMs(day("2026-11-01"), tz)).toBe(25 * HOUR_MS);
  });

  it("0:00 が存在しない日でも「実際の日の始まり」を返す", () => {
    // America/Santiago の 2026-09-06 は 0:00 に夏時間が始まり、0:00〜0:59 が存在しない
    // (この日の始まりは 1:00)。dayTime.ts の説明どおり toZonedDateTime が吸収する
    const tz = "America/Santiago";
    const start = dayStartMs(day("2026-09-06"), tz);
    const local = Temporal.Instant.fromEpochMilliseconds(start)
      .toZonedDateTimeISO(tz)
      .toPlainDateTime();
    expect(local.toString()).toBe("2026-09-06T01:00:00");
    // 「その日に属する最初の瞬間」であること: 1ms 前は前日
    expect(plainDateOfMs(start - 1, tz).toString()).toBe("2026-09-05");
    expect(plainDateOfMs(start, tz).toString()).toBe("2026-09-06");
  });
});

describe("dayRangeMs", () => {
  it("dayCount=1 は「その日の 0:00 と翌日の 0:00」(半開区間)", () => {
    expect(dayRangeMs(day("2026-07-25"), 1, TZ)).toEqual({
      startMs: ms("2026-07-25T00:00"),
      endMs: ms("2026-07-26T00:00"),
    });
  });

  it("dayCount=1 の endMs は翌日の dayStartMs と一致する(2つの関数の整合)", () => {
    expect(dayRangeMs(day("2026-07-25"), 1, TZ).endMs).toBe(dayStartMs(day("2026-07-26"), TZ));
  });

  it("複数日(週表示の7日)", () => {
    expect(dayRangeMs(day("2026-07-20"), 7, TZ)).toEqual({
      startMs: ms("2026-07-20T00:00"),
      endMs: ms("2026-07-27T00:00"),
    });
  });

  it("月をまたいでも日数ぶん進む(7/29 + 7日 = 8/5)", () => {
    expect(dayRangeMs(day("2026-07-29"), 7, TZ).endMs).toBe(ms("2026-08-05T00:00"));
  });

  it("年をまたいでも日数ぶん進む(12/30 + 3日 = 翌年 1/2)", () => {
    expect(dayRangeMs(day("2026-12-30"), 3, TZ).endMs).toBe(ms("2027-01-02T00:00"));
  });

  it("月グリッドの42日ぶん(monthGridRangeMs が使う形)", () => {
    // 2026-06-29(月)始まりの6週 = 42日 → 2026-08-10 の 0:00 まで
    expect(dayRangeMs(day("2026-06-29"), 42, TZ)).toEqual({
      startMs: ms("2026-06-29T00:00"),
      endMs: ms("2026-08-10T00:00"),
    });
  });

  it("DST を含む区間は 24時間 × 日数 にはならない(壁時計で日を足している証拠)", () => {
    // America/New_York の 2026-03-01 から14日ぶんには夏時間開始 (3/8) が1回入るので 1時間短い
    const tz = "America/New_York";
    const { startMs, endMs } = dayRangeMs(day("2026-03-01"), 14, tz);
    expect(endMs - startMs).toBe(14 * DAY_MS - HOUR_MS);
    expect(endMs).toBe(dayStartMs(day("2026-03-15"), tz));
  });

  it("DST 終了を含む区間は1時間長い", () => {
    // 2026-11-01 の夏時間終了(25時間の日)を含む2日ぶん
    const tz = "America/New_York";
    const { startMs, endMs } = dayRangeMs(day("2026-11-01"), 2, tz);
    expect(endMs - startMs).toBe(2 * DAY_MS + HOUR_MS);
  });

  it("dayCount=0 は空区間(startMs === endMs)", () => {
    // dayCountForView('month') が 0 を返すので、0 でも壊れないことを固定しておく
    const { startMs, endMs } = dayRangeMs(day("2026-07-25"), 0, TZ);
    expect(startMs).toBe(ms("2026-07-25T00:00"));
    expect(endMs).toBe(startMs);
  });
});

describe("plainDateOfMs", () => {
  it("その日の 00:00:00 ちょうどはその日", () => {
    expect(plainDateOfMs(ms("2026-07-25T00:00"), TZ).toString()).toBe("2026-07-25");
  });

  it("翌日 00:00:00 の 1ms 前はまだその日(半開区間の右端)", () => {
    expect(plainDateOfMs(ms("2026-07-26T00:00") - 1, TZ).toString()).toBe("2026-07-25");
  });

  it("翌日 00:00:00 ちょうどは翌日(オフバイワンの境界)", () => {
    expect(plainDateOfMs(ms("2026-07-26T00:00"), TZ).toString()).toBe("2026-07-26");
  });

  it("同じ瞬間でもタイムゾーンが違えば別の日になる", () => {
    // 東京の 7/25 8:00 は UTC ではまだ 7/24 23:00
    const instant = ms("2026-07-25T08:00");
    expect(plainDateOfMs(instant, TZ).toString()).toBe("2026-07-25");
    expect(plainDateOfMs(instant, "UTC").toString()).toBe("2026-07-24");
  });

  it("dayStartMs と往復する(どの日でも自分自身に戻る)", () => {
    for (const iso of ["2026-01-01", "2026-02-28", "2026-07-25", "2026-12-31"]) {
      expect(plainDateOfMs(dayStartMs(day(iso), TZ), TZ).toString()).toBe(iso);
    }
  });

  it("DST の切り替え日でも往復する(23時間の日 / 25時間の日)", () => {
    const tz = "America/New_York";
    for (const iso of ["2026-03-08", "2026-11-01"]) {
      expect(plainDateOfMs(dayStartMs(day(iso), tz), tz).toString()).toBe(iso);
    }
  });
});

describe("allDayRangeCoversDate", () => {
  const range = { startDate: "2026-07-09", endDate: "2026-07-12" };

  it("開始日と同じ日は含む(両端 inclusive)", () => {
    expect(allDayRangeCoversDate(range, "2026-07-09")).toBe(true);
  });

  it("終了日と同じ日は含む(両端 inclusive)", () => {
    expect(allDayRangeCoversDate(range, "2026-07-12")).toBe(true);
  });

  it("間の日は含む", () => {
    expect(allDayRangeCoversDate(range, "2026-07-10")).toBe(true);
    expect(allDayRangeCoversDate(range, "2026-07-11")).toBe(true);
  });

  it("範囲外(前後1日)は含まない", () => {
    expect(allDayRangeCoversDate(range, "2026-07-08")).toBe(false);
    expect(allDayRangeCoversDate(range, "2026-07-13")).toBe(false);
  });

  it("単日(startDate === endDate)はその日だけ", () => {
    const single = { startDate: "2026-07-09", endDate: "2026-07-09" };
    expect(allDayRangeCoversDate(single, "2026-07-09")).toBe(true);
    expect(allDayRangeCoversDate(single, "2026-07-08")).toBe(false);
    expect(allDayRangeCoversDate(single, "2026-07-10")).toBe(false);
  });

  it("1桁日と2桁日の比較がゼロ詰めで正しく効く(9日 vs 10日)", () => {
    // ここがこの関数の生命線: 文字列比較なので "2026-07-09" < "2026-07-10" が
    // 成り立つ必要がある。もしゼロ詰めでない表記 ("2026-7-9") が混ざると
    // '9' > '1' で辞書順が逆転し、日付順の前提が静かに壊れる。
    // 呼び出し元が渡すのは PlainDate.toString() なので、そこから取った値で確かめる
    const ninth = day("2026-07-09").toString();
    const tenth = day("2026-07-10").toString();
    expect(ninth < tenth).toBe(true);
    const upTo9 = { startDate: "2026-07-01", endDate: "2026-07-09" };
    expect(allDayRangeCoversDate(upTo9, "2026-07-09")).toBe(true);
    expect(allDayRangeCoversDate(upTo9, "2026-07-10")).toBe(false);
    const from10 = { startDate: "2026-07-10", endDate: "2026-07-31" };
    expect(allDayRangeCoversDate(from10, "2026-07-09")).toBe(false);
    expect(allDayRangeCoversDate(from10, "2026-07-10")).toBe(true);
  });

  it("1桁月と2桁月の比較もゼロ詰めで効く(9月 vs 10月)", () => {
    const sep30 = day("2026-09-30").toString();
    const oct1 = day("2026-10-01").toString();
    expect(sep30 < oct1).toBe(true);
    const crossing = { startDate: "2026-09-28", endDate: "2026-10-02" };
    expect(allDayRangeCoversDate(crossing, "2026-09-30")).toBe(true);
    expect(allDayRangeCoversDate(crossing, "2026-10-01")).toBe(true);
    expect(allDayRangeCoversDate(crossing, "2026-09-27")).toBe(false);
    expect(allDayRangeCoversDate(crossing, "2026-10-03")).toBe(false);
  });

  it("月をまたぐ範囲", () => {
    const crossing = { startDate: "2026-07-28", endDate: "2026-08-03" };
    expect(allDayRangeCoversDate(crossing, "2026-07-31")).toBe(true);
    expect(allDayRangeCoversDate(crossing, "2026-08-01")).toBe(true);
    expect(allDayRangeCoversDate(crossing, "2026-07-27")).toBe(false);
    expect(allDayRangeCoversDate(crossing, "2026-08-04")).toBe(false);
  });

  it("年をまたぐ範囲", () => {
    const crossing = { startDate: "2026-12-30", endDate: "2027-01-02" };
    expect(allDayRangeCoversDate(crossing, "2026-12-31")).toBe(true);
    expect(allDayRangeCoversDate(crossing, "2027-01-01")).toBe(true);
    expect(allDayRangeCoversDate(crossing, "2026-12-29")).toBe(false);
    expect(allDayRangeCoversDate(crossing, "2027-01-03")).toBe(false);
  });

  it("Temporal.PlainDate.toString() は常にゼロ詰めの YYYY-MM-DD(呼び出し側の前提)", () => {
    // 呼び出し元は day.toString() を dateStr として渡す。その表記が固定長であることが
    // 「辞書順 = 日付順」の根拠なので、前提そのものをここで固定しておく
    expect(day("2026-07-09").toString()).toBe("2026-07-09");
    expect(day("2026-01-01").toString()).toBe("2026-01-01");
  });

  it("置き換え前の Temporal.PlainDate.compare 版と全て同じ答えを返す", () => {
    // 2026-07-31 に PlainDate.compare からこの文字列比較へ寄せた(横断レビュー B-4)。
    // 等価であることを、境界をまたぐ代表的な範囲 × 連続する日で総当たりして固定する
    const ranges = [
      { startDate: "2026-07-09", endDate: "2026-07-12" },
      { startDate: "2026-07-31", endDate: "2026-07-31" },
      { startDate: "2026-09-28", endDate: "2026-10-02" },
      { startDate: "2026-12-30", endDate: "2027-01-02" },
    ];
    for (const r of ranges) {
      const start = Temporal.PlainDate.from(r.startDate);
      const end = Temporal.PlainDate.from(r.endDate);
      for (let i = -3; i <= 6; i++) {
        const d = start.add({ days: i });
        const viaCompare =
          Temporal.PlainDate.compare(d, start) >= 0 && Temporal.PlainDate.compare(d, end) <= 0;
        expect(allDayRangeCoversDate(r, d.toString())).toBe(viaCompare);
      }
    }
  });
});
