import { Temporal } from "@js-temporal/polyfill";

/**
 * 複数タイムゾーン(時刻軸の脇に、別のタイムゾーンの時刻を並べる)の純関数群。
 * 基準の表示は、これまでどおり端末のタイムゾーン。ここで扱うのは「追加で並べるタイムゾーン」の
 * 検証・並べ方・ラベルだけで、DOM も保存も持たない(保存は sync/secondaryTimeZonesPref.ts)。
 */

/** 並べられるタイムゾーンの数。1 つにつき時刻軸が約 44px 広がるので、2 つまで。 */
export const MAX_SECONDARY_TIME_ZONES = 2;

/** IANA のタイムゾーン ID として使えるか(Intl が受け付けるか)。 */
export function isValidTimeZone(id: unknown): id is string {
  if (typeof id !== "string" || id.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: id });
    return true;
  } catch {
    return false;
  }
}

/**
 * 保存値(JSON 配列)を、並べるタイムゾーンの一覧に正規化する。壊れた値・使えない ID・重複・
 * 基準のタイムゾーンと同じもの・上限を超える分は、黙って落とす(読めない値で画面を壊さない)。
 */
export function normalizeSecondaryTimeZones(raw: unknown, primary?: string): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (!isValidTimeZone(item) || item === primary || out.includes(item)) continue;
    out.push(item);
    if (out.length >= MAX_SECONDARY_TIME_ZONES) break;
  }
  return out;
}

/** 保存文字列(JSON)を一覧にする。JSON として読めなければ空。 */
export function parseSecondaryTimeZones(raw: string, primary?: string): string[] {
  try {
    return normalizeSecondaryTimeZones(JSON.parse(raw), primary);
  } catch {
    return [];
  }
}

/** "America/New_York" → "New York"。時刻軸の見出しと、設定の一覧に使う短い名前。 */
export function timeZoneCity(id: string): string {
  return (id.split("/").pop() ?? id).replace(/_/g, " ");
}

/** その日(基準のタイムゾーンの日付)の、その時点での UTC からのずれ。"GMT+9" / "GMT-5" / "GMT+5:30"。 */
export function timeZoneOffsetLabel(timeZone: string, day: Temporal.PlainDate): string {
  const minutes = day.toZonedDateTime({ timeZone, plainTime: "12:00" }).offsetNanoseconds / 60_000_000_000;
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `GMT${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/**
 * 基準のタイムゾーンの day の 0〜23 時それぞれが、別のタイムゾーンでは何時かのラベル(24 時間表記、
 * 基準の時刻軸の "9:00" と同じ書き方)。30 分・45 分ずれる地域は "9:30" のように分も出す。
 * 夏時間の切り替え日は、基準の側の壁時計(その日の h 時)を起点にするので、行は基準の軸と必ず対応する。
 */
export function hourLabelsIn(
  timeZone: string,
  primaryTimeZone: string,
  day: Temporal.PlainDate,
): string[] {
  return Array.from({ length: 24 }, (_, hour) => {
    const t = day
      .toZonedDateTime({ timeZone: primaryTimeZone, plainTime: Temporal.PlainTime.from({ hour }) })
      .withTimeZone(timeZone);
    return `${t.hour}:${String(t.minute).padStart(2, "0")}`;
  });
}
