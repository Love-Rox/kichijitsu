import { Temporal } from "@js-temporal/polyfill";

/**
 * Hermes (React Native の JS エンジン) で、Web 版が使っている Temporal ポリフィルの
 * タイムゾーン計算が正しく動くかの検証 (2026-11-06)。Web の予定の計算 (layout/*, sync/mapGoogle.ts)
 * は @js-temporal/polyfill の ZonedDateTime に依存しているので、動かなければ共有できない。
 */
export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

function check(name: string, run: () => { ok: boolean; detail: string }): CheckResult {
  try {
    return { name, ...run() };
  } catch (e) {
    return { name, ok: false, detail: `例外: ${String(e)}` };
  }
}

export function runTemporalChecks(): CheckResult[] {
  const results: CheckResult[] = [];

  results.push(
    check("端末のタイムゾーン", () => {
      const id = Temporal.Now.timeZoneId();
      return { ok: id.length > 0, detail: id };
    }),
  );

  results.push(
    check("Asia/Tokyo の日の始まり(epoch ms)", () => {
      const ms = Temporal.PlainDate.from("2026-11-06").toZonedDateTime({
        timeZone: "Asia/Tokyo",
      }).epochMilliseconds;
      const expected = Date.UTC(2026, 10, 5, 15, 0);
      return { ok: ms === expected, detail: `${ms} (期待 ${expected})` };
    }),
  );

  results.push(
    check("America/New_York: 夏時間の開始日は 23 時間", () => {
      const start = Temporal.PlainDate.from("2026-03-08").toZonedDateTime({
        timeZone: "America/New_York",
      });
      const hours = start.add({ days: 1 }).epochMilliseconds - start.epochMilliseconds;
      const h = hours / 3_600_000;
      return { ok: h === 23, detail: `${h} 時間` };
    }),
  );

  results.push(
    check("America/New_York: 夏時間をまたぐ +1h", () => {
      const z = Temporal.ZonedDateTime.from("2026-03-08T01:30:00[America/New_York]").add({
        hours: 1,
      });
      const s = z.toString();
      return { ok: s.startsWith("2026-03-08T03:30:00-04:00"), detail: s };
    }),
  );

  results.push(
    check("Europe/London の壁時計 → epoch", () => {
      const z = Temporal.ZonedDateTime.from("2026-07-01T12:00:00[Europe/London]");
      const expected = Date.UTC(2026, 6, 1, 11, 0);
      return { ok: z.epochMilliseconds === expected, detail: `${z.epochMilliseconds}` };
    }),
  );

  results.push(
    check("Instant → Asia/Tokyo の曜日と時刻", () => {
      const z = Temporal.Instant.fromEpochMilliseconds(Date.UTC(2026, 10, 6, 6, 30))
        .toZonedDateTimeISO("Asia/Tokyo");
      return {
        ok: z.dayOfWeek === 5 && z.hour === 15 && z.minute === 30,
        detail: `曜日 ${z.dayOfWeek} ${z.hour}:${z.minute}`,
      };
    }),
  );

  results.push(
    check("性能: 日の境界の計算 2000 回", () => {
      const t0 = Date.now();
      let sum = 0;
      for (let i = 0; i < 2000; i++) {
        sum += Temporal.PlainDate.from("2026-11-06")
          .add({ days: i % 60 })
          .toZonedDateTime({ timeZone: "Asia/Tokyo" }).epochMilliseconds;
      }
      const ms = Date.now() - t0;
      return { ok: sum > 0 && ms < 3000, detail: `${ms} ms` };
    }),
  );

  return results;
}
