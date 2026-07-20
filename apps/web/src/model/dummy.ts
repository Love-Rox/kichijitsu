import { Temporal } from "@js-temporal/polyfill";
import type { Occurrence } from "./types";
import type { EventSeries, InstanceOverride } from "./series";
import { instanceId } from "./series";

/** mulberry32 — シード付き PRNG。同じシードなら常に同じデータになる */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TITLES = [
  "デザインレビュー",
  "集中作業",
  "コードレビュー",
  "打ち合わせ",
  "スプリント計画",
  "歯医者",
];

const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];

/** ISO ローカル日時文字列 + タイムゾーンを epoch ms に変換する小さなヘルパー */
function localIsoToEpochMs(iso: string, timeZone: string): number {
  return Temporal.PlainDateTime.from(iso).toZonedDateTime(timeZone).epochMilliseconds;
}

/**
 * シード用の繰り返しシリーズを5〜7個生成する。
 *
 * dtstartIso は「現在(2026-07-19頃)から数週間前」になるよう 2026-06 の
 * 日付をリテラルで固定している(Date.now() 等の実行時刻には一切依存しない
 * = 常に同じ出力になる)。各 dtstart の曜日は対応する RRULE の BYDAY と
 * 整合するように選んである(例: MO,WE シリーズの dtstart は実際に月曜)ので、
 * dtstart 自身が展開結果の最初の1回に一致する ─ exdatesMs / override の
 * ターゲット時刻をここから安全に計算できる。
 */
export function generateDummySeries(timeZone: string): EventSeries[] {
  const standupDtstartIso = "2026-06-15T10:00"; // 月曜
  const standupExcludedMs = localIsoToEpochMs(standupDtstartIso, timeZone);

  return [
    {
      id: "series-standup",
      title: "定例ミーティング",
      color: "#3b82f6",
      source: "local",
      dtstartIso: standupDtstartIso,
      timeZone,
      durationMin: 30,
      rrule: "FREQ=WEEKLY;BYDAY=MO,WE",
      // 初回 (6/15 月) だけ欠番にする
      exdatesMs: [standupExcludedMs],
    },
    {
      id: "series-1on1",
      title: "1on1",
      color: "#8b5cf6",
      source: "local",
      dtstartIso: "2026-06-18T14:00", // 木曜
      timeZone,
      durationMin: 30,
      rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TH",
      exdatesMs: [],
    },
    {
      id: "series-retro",
      title: "ふりかえり",
      color: "#10b981",
      source: "local",
      dtstartIso: "2026-06-26T16:00", // 6月最終金曜
      timeZone,
      durationMin: 60,
      rrule: "FREQ=MONTHLY;BYDAY=-1FR",
      exdatesMs: [],
    },
    {
      id: "series-release",
      title: "リリース会",
      color: "#f59e0b",
      source: "local",
      dtstartIso: "2026-06-09T11:00", // 6月第2火曜
      timeZone,
      durationMin: 45,
      rrule: "FREQ=MONTHLY;BYDAY=2TU",
      exdatesMs: [],
    },
    {
      id: "series-lunch",
      title: "ランチ",
      color: "#06b6d4",
      source: "local",
      dtstartIso: "2026-06-01T12:00", // 毎日
      timeZone,
      durationMin: 60,
      rrule: "FREQ=DAILY",
      exdatesMs: [],
    },
    {
      id: "series-gym",
      title: "ジム",
      color: "#ef4444",
      source: "local",
      dtstartIso: "2026-06-09T07:30", // 火曜
      timeZone,
      durationMin: 45,
      rrule: "FREQ=WEEKLY;BYDAY=TU,FR",
      exdatesMs: [],
    },
  ];
}

/**
 * シード用の InstanceOverride を1件生成する: series-1on1 の初回を
 * 30分後ろ倒しにする部分上書き。対象 series は generateDummySeries の
 * 結果からタイトル通り "series-1on1" を探して使う。
 */
export function generateDummyOverrides(series: EventSeries[]): InstanceOverride[] {
  const target = series.find((s) => s.id === "series-1on1");
  if (!target) return [];

  const originalStartMs = localIsoToEpochMs(target.dtstartIso, target.timeZone);
  const shiftMs = 30 * 60_000;
  const defaultEndMs = originalStartMs + target.durationMin * 60_000;

  return [
    {
      id: instanceId(target.id, originalStartMs),
      seriesId: target.id,
      originalStartMs,
      patch: {
        startMs: originalStartMs + shiftMs,
        endMs: defaultEndMs + shiftMs,
      },
    },
  ];
}

/**
 * baseDate を含む週から前後 weeks 週ぶんの単発ダミー occurrence を生成する。
 * DAILY シリーズ (ランチ) が既に日々の枠を1つ埋めるため、密度は1日
 * 1〜3個に抑えてある。意図的に重なりクラスタも作り、レイアウトの試験台にする。
 */
export function generateDummyOccurrences(
  baseDate: Temporal.PlainDate,
  timeZone: string,
  weeks = 8,
  seed = 20260719,
): Occurrence[] {
  const rand = mulberry32(seed);
  const out: Occurrence[] = [];
  const startDay = baseDate.subtract({ weeks }).subtract({ days: baseDate.dayOfWeek % 7 });
  const totalDays = weeks * 2 * 7;

  for (let d = 0; d < totalDays; d++) {
    const day = startDay.add({ days: d });
    const count = 1 + Math.floor(rand() * 3); // 1..3 events/day
    for (let i = 0; i < count; i++) {
      const startHour = 8 + Math.floor(rand() * 11); // 8:00..18:00
      const startMin = [0, 15, 30, 45][Math.floor(rand() * 4)];
      const durationMin = [15, 30, 30, 45, 60, 60, 90, 120][Math.floor(rand() * 8)];
      const zdt = day.toZonedDateTime({
        timeZone,
        plainTime: new Temporal.PlainTime(startHour, startMin),
      });
      const startMs = zdt.epochMilliseconds;
      out.push({
        id: `dummy-${d}-${i}`,
        seriesId: null,
        title: TITLES[Math.floor(rand() * TITLES.length)],
        startMs,
        endMs: startMs + durationMin * 60_000,
        color: COLORS[Math.floor(rand() * COLORS.length)],
        source: "local",
      });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}
