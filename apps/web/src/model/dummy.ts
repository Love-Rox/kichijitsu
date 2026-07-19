import { Temporal } from '@js-temporal/polyfill'
import type { Occurrence } from './types'

/** mulberry32 — シード付き PRNG。同じシードなら常に同じデータになる */
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TITLES = [
  '定例ミーティング',
  '1on1',
  'デザインレビュー',
  'ランチ',
  '集中作業',
  'コードレビュー',
  '打ち合わせ',
  'スプリント計画',
  '歯医者',
  'ジム',
]

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4']

/**
 * baseDate を含む週から前後 weeks 週ぶんのダミー occurrence を生成する。
 * 意図的に重なりクラスタ（同時刻帯に複数予定)を作り、レイアウトの試験台にする。
 */
export function generateDummyOccurrences(
  baseDate: Temporal.PlainDate,
  timeZone: string,
  weeks = 8,
  seed = 20260719,
): Occurrence[] {
  const rand = mulberry32(seed)
  const out: Occurrence[] = []
  const startDay = baseDate.subtract({ weeks }).subtract({ days: baseDate.dayOfWeek % 7 })
  const totalDays = weeks * 2 * 7

  for (let d = 0; d < totalDays; d++) {
    const day = startDay.add({ days: d })
    const count = 2 + Math.floor(rand() * 5) // 2..6 events/day
    for (let i = 0; i < count; i++) {
      const startHour = 8 + Math.floor(rand() * 11) // 8:00..18:00
      const startMin = [0, 15, 30, 45][Math.floor(rand() * 4)]
      const durationMin = [15, 30, 30, 45, 60, 60, 90, 120][Math.floor(rand() * 8)]
      const zdt = day.toZonedDateTime({
        timeZone,
        plainTime: new Temporal.PlainTime(startHour, startMin),
      })
      const startMs = zdt.epochMilliseconds
      out.push({
        id: `dummy-${d}-${i}`,
        seriesId: null,
        title: TITLES[Math.floor(rand() * TITLES.length)],
        startMs,
        endMs: startMs + durationMin * 60_000,
        color: COLORS[Math.floor(rand() * COLORS.length)],
      })
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs)
}
