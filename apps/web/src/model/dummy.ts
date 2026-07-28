import { Temporal } from "@js-temporal/polyfill";
import type { AllDayOccurrence, Occurrence } from "./types";
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
 * 終日予定のダミー (2026-07-28)。
 *
 * 追加理由: 「終日の不在を終日欄に出すかタイムラインに載せるか」の設定
 * (layout/oooAllDayPlacement.ts) を `?demo=1` で目視確認しようにも、従来のデモデータには
 * 終日予定そのものが1件も無く、終日の不在に至っては当然存在しなかった。
 *
 * 他のダミーと違い IndexedDB には保存しない ―― 呼び出し側 (db/bootstrap.ts) が
 * allDayStore へメモリ上で load するだけ(そのため cleanupDemoData の掃除対象にも
 * ならず、実データ運用の環境に残骸が残る余地が無い)。
 *
 * 中身は「不在(終日・単日/複数日)」と「不在ではない通常の終日予定」を混ぜてある ――
 * 設定を切り替えたときに、不在だけが終日レーンとタイムラインの間を行き来し、
 * 通常の終日予定は動かないことを一目で確かめられるようにするため。
 */
export function generateDummyAllDayOccurrences(baseDate: Temporal.PlainDate): AllDayOccurrence[] {
  const d = (offset: number) => baseDate.add({ days: offset }).toString();
  return [
    {
      id: "dummy-allday-holiday",
      seriesId: null,
      title: "全社ミーティングデー",
      startDate: d(0),
      endDate: d(0),
      color: "#10b981",
      source: "local",
    },
    {
      id: "dummy-allday-ooo-single",
      seriesId: null,
      title: "有給休暇",
      startDate: d(1),
      endDate: d(1),
      color: "#ef4444",
      source: "local",
      isOutOfOffice: true,
    },
    {
      id: "dummy-allday-offsite",
      seriesId: null,
      title: "オフサイト合宿",
      startDate: d(2),
      endDate: d(3),
      color: "#3b82f6",
      source: "local",
    },
    {
      id: "dummy-allday-ooo-span",
      seriesId: null,
      title: "夏季休暇",
      startDate: d(3),
      endDate: d(4),
      color: "#f59e0b",
      source: "local",
      isOutOfOffice: true,
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
