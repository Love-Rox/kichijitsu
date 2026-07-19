import { Temporal } from '@js-temporal/polyfill'
import type { Occurrence } from '../model/types'
import type { EventSeries, InstanceOverride } from '../model/series'
import { instanceId } from '../model/series'

/**
 * シリーズ定義を [windowStartMs, windowEndMs) の occurrence 配列へ展開する。
 * 純関数（IndexedDB や DOM に触れない）— Web Worker からもテストからも呼ばれる。
 *
 * 実装上の必須事項:
 * - 反復は series.timeZone の壁時計基準で Temporal.ZonedDateTime の
 *   add() を使って進める（DST を跨いでも開始の壁時計時刻が保たれる）。
 *   epoch ms への変換は各回の最後に行う
 * - COUNT は RRULE が生成する集合に適用し、その後 EXDATE で除外、
 *   その後 override を適用、最後にウィンドウでフィルタする
 * - occurrence.id と originalStartMs は instanceId() の規則に従う
 * - patch === null の override はその回をキャンセル（結果から除外）
 */
export interface ExpandInput {
  series: EventSeries
  /** この series に対する override のみを渡す */
  overrides: InstanceOverride[]
  windowStartMs: number
  windowEndMs: number
}

/** 無限ループ・暴走対策の生成上限 */
const MAX_OCCURRENCES = 100_000

const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
type WeekdayCode = (typeof WEEKDAY_CODES)[number]

interface ParsedRRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval: number
  byDay: string[] // 生の BYDAY トークン (例 "MO", "2TU", "-1FR")
  byMonthDay: number | null
  until: number | null // epoch ms (UTC instant), inclusive
  count: number | null
}

function parseRRule(rrule: string): ParsedRRule {
  const parts = rrule.split(';').filter((p) => p.length > 0)
  const map = new Map<string, string>()
  for (const part of parts) {
    const eqIdx = part.indexOf('=')
    if (eqIdx === -1) continue
    map.set(part.slice(0, eqIdx).toUpperCase(), part.slice(eqIdx + 1))
  }

  const freqRaw = map.get('FREQ')
  if (
    freqRaw !== 'DAILY' &&
    freqRaw !== 'WEEKLY' &&
    freqRaw !== 'MONTHLY' &&
    freqRaw !== 'YEARLY'
  ) {
    throw new Error(`expandSeries: unsupported FREQ "${freqRaw ?? '(missing)'}"`)
  }

  const intervalRaw = map.get('INTERVAL')
  const interval = intervalRaw ? Number.parseInt(intervalRaw, 10) : 1

  const byDayRaw = map.get('BYDAY')
  const byDay = byDayRaw ? byDayRaw.split(',').map((s) => s.trim().toUpperCase()) : []

  const byMonthDayRaw = map.get('BYMONTHDAY')
  const byMonthDay = byMonthDayRaw ? Number.parseInt(byMonthDayRaw, 10) : null

  const untilRaw = map.get('UNTIL')
  const until = untilRaw ? parseUntil(untilRaw) : null

  const countRaw = map.get('COUNT')
  const count = countRaw ? Number.parseInt(countRaw, 10) : null

  return { freq: freqRaw, interval, byDay, byMonthDay, until, count }
}

/** UNTIL=YYYYMMDD または YYYYMMDDTHHMMSSZ を UTC epoch ms に変換 */
function parseUntil(raw: string): number {
  if (/^\d{8}$/.test(raw)) {
    // 日付のみ: その日の終わり (23:59:59.999 UTC) までを inclusive とする
    const year = Number.parseInt(raw.slice(0, 4), 10)
    const month = Number.parseInt(raw.slice(4, 6), 10)
    const day = Number.parseInt(raw.slice(6, 8), 10)
    const plainDate = new Temporal.PlainDate(year, month, day)
    const instant = plainDate
      .toZonedDateTime('UTC')
      .add({ days: 1 })
      .toInstant()
      .epochMilliseconds
    return instant - 1
  }
  if (/^\d{8}T\d{6}Z$/.test(raw)) {
    const year = Number.parseInt(raw.slice(0, 4), 10)
    const month = Number.parseInt(raw.slice(4, 6), 10)
    const day = Number.parseInt(raw.slice(6, 8), 10)
    const hour = Number.parseInt(raw.slice(9, 11), 10)
    const minute = Number.parseInt(raw.slice(11, 13), 10)
    const second = Number.parseInt(raw.slice(13, 15), 10)
    const zdt = Temporal.ZonedDateTime.from({
      timeZone: 'UTC',
      year,
      month,
      day,
      hour,
      minute,
      second,
    })
    return zdt.toInstant().epochMilliseconds
  }
  throw new Error(`expandSeries: unrecognized UNTIL format "${raw}"`)
}

/** BYDAY トークン (例 "2TU", "-1FR", "MO") をパース */
function parseByDayToken(token: string): { ordinal: number | null; weekday: WeekdayCode } {
  const match = /^(-?\d+)?([A-Z]{2})$/.exec(token)
  if (!match) {
    throw new Error(`expandSeries: invalid BYDAY token "${token}"`)
  }
  const code = match[2] as WeekdayCode
  if (!WEEKDAY_CODES.includes(code)) {
    throw new Error(`expandSeries: invalid BYDAY weekday "${token}"`)
  }
  const ordinal = match[1] ? Number.parseInt(match[1], 10) : null
  return { ordinal, weekday: code }
}

function weekdayCodeOf(zdt: Temporal.ZonedDateTime): WeekdayCode {
  // Temporal dayOfWeek: 1 = Monday ... 7 = Sunday
  return WEEKDAY_CODES[zdt.dayOfWeek - 1]
}

/**
 * 与えられた月の中で、指定曜日+序数に一致する日を返す (例 第2火曜、最終金曜)。
 * ordinal が正なら月頭から数えて ordinal 番目、負なら月末から数えて |ordinal| 番目。
 */
function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: WeekdayCode,
  ordinal: number,
): number | null {
  const daysInMonth = Temporal.PlainDate.from({ year, month, day: 1 }).daysInMonth
  const targetDow = WEEKDAY_CODES.indexOf(weekday) + 1 // 1..7

  const matchingDays: number[] = []
  for (let day = 1; day <= daysInMonth; day++) {
    const pd = Temporal.PlainDate.from({ year, month, day })
    if (pd.dayOfWeek === targetDow) {
      matchingDays.push(day)
    }
  }

  if (ordinal > 0) {
    return matchingDays[ordinal - 1] ?? null
  }
  // ordinal < 0: 末尾から数える
  const idx = matchingDays.length + ordinal // ordinal は負数
  return matchingDays[idx] ?? null
}

/**
 * dtstart から始まる ZonedDateTime の反復を、FREQ/INTERVAL に従って生成する
 * ジェネレータ。BYDAY/BYMONTHDAY による同一「period」内の複数候補にも対応する。
 */
function* generateCandidates(
  dtstart: Temporal.ZonedDateTime,
  rule: ParsedRRule,
): Generator<Temporal.ZonedDateTime> {
  const { freq, interval, byDay, byMonthDay } = rule

  if (freq === 'DAILY') {
    let cursor = dtstart
    while (true) {
      yield cursor
      cursor = cursor.add({ days: interval })
    }
  } else if (freq === 'WEEKLY') {
    const weekdays: WeekdayCode[] =
      byDay.length > 0
        ? byDay.map((tok) => parseByDayToken(tok).weekday)
        : [weekdayCodeOf(dtstart)]
    const weekdayNums = weekdays.map((w) => WEEKDAY_CODES.indexOf(w) + 1).sort((a, b) => a - b)

    // dtstart が属する週の月曜を基準に進める
    const weekStart = dtstart.subtract({ days: dtstart.dayOfWeek - 1 })
    let weekCursor = weekStart
    while (true) {
      for (const dow of weekdayNums) {
        const candidate = weekCursor.add({ days: dow - 1 })
        if (Temporal.ZonedDateTime.compare(candidate, dtstart) >= 0) {
          yield candidate
        }
      }
      weekCursor = weekCursor.add({ weeks: interval })
    }
  } else if (freq === 'MONTHLY') {
    const ordinalTokens = byDay
      .map(parseByDayToken)
      .filter((t) => t.ordinal !== null) as { ordinal: number; weekday: WeekdayCode }[]

    let monthCursor = dtstart.with({ day: 1 })
    let first = true
    while (true) {
      const year = monthCursor.year
      const month = monthCursor.month

      const candidateDays: number[] = []
      if (ordinalTokens.length > 0) {
        for (const { ordinal, weekday } of ordinalTokens) {
          const day = nthWeekdayOfMonth(year, month, weekday, ordinal)
          if (day !== null) candidateDays.push(day)
        }
        candidateDays.sort((a, b) => a - b)
      } else {
        const targetDay = byMonthDay ?? dtstart.day
        const daysInMonth = Temporal.PlainDate.from({ year, month, day: 1 }).daysInMonth
        if (targetDay >= 1 && targetDay <= daysInMonth) {
          candidateDays.push(targetDay)
        }
        // 存在しない日（31日など）の月はスキップ
      }

      for (const day of candidateDays) {
        const candidate = monthCursor.with({ day })
        if (!first || Temporal.ZonedDateTime.compare(candidate, dtstart) >= 0) {
          yield candidate
        }
      }
      first = false
      monthCursor = monthCursor.add({ months: interval })
    }
  } else if (freq === 'YEARLY') {
    let cursor = dtstart
    while (true) {
      yield cursor
      cursor = cursor.add({ years: interval })
    }
  } else {
    // 到達しないはずだが型安全のため
    throw new Error(`expandSeries: unsupported FREQ "${freq as string}"`)
  }
}

export function expandSeries(input: ExpandInput): Occurrence[] {
  const { series, overrides, windowStartMs, windowEndMs } = input
  const rule = parseRRule(series.rrule)

  const dtstart = Temporal.PlainDateTime.from(series.dtstartIso).toZonedDateTime(series.timeZone)

  const exdatesSet = new Set(series.exdatesMs)
  const overrideMap = new Map<number, InstanceOverride>()
  for (const ov of overrides) {
    overrideMap.set(ov.originalStartMs, ov)
  }

  const result: Occurrence[] = []
  let generatedCount = 0
  let emittedCount = 0 // COUNT は EXDATE 適用前の生成集合に対して数える

  for (const zdt of generateCandidates(dtstart, rule)) {
    generatedCount++
    if (generatedCount > MAX_OCCURRENCES) break

    const originalStartMs = zdt.toInstant().epochMilliseconds

    if (rule.until !== null && originalStartMs > rule.until) {
      break
    }

    // COUNT は生成集合 (EXDATE 適用前) に適用する
    if (rule.count !== null && emittedCount >= rule.count) {
      break
    }
    emittedCount++

    // 十分ウィンドウを超えて進んだら打ち切り（COUNT/UNTIL 無しの無限反復対策）
    if (rule.count === null && rule.until === null && originalStartMs >= windowEndMs) {
      break
    }

    if (exdatesSet.has(originalStartMs)) {
      continue
    }

    const defaultStartMs = originalStartMs
    const defaultEndMs = originalStartMs + series.durationMin * 60_000

    const override = overrideMap.get(originalStartMs)
    if (override && override.patch === null) {
      continue
    }

    const startMs = override?.patch?.startMs ?? defaultStartMs
    const endMs = override?.patch?.endMs ?? defaultEndMs
    const title = override?.patch?.title ?? series.title
    const color = override?.patch?.color ?? series.color

    if (startMs < windowStartMs || startMs >= windowEndMs) {
      continue
    }

    result.push({
      id: instanceId(series.id, originalStartMs),
      seriesId: series.id,
      title,
      startMs,
      endMs,
      color,
      source: series.source,
      originalStartMs,
    })
  }

  result.sort((a, b) => a.startMs - b.startMs)
  return result
}
