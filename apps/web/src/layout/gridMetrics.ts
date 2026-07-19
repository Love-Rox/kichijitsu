import { Temporal } from '@js-temporal/polyfill'

/**
 * 週グリッドの座標系（px⇔分）と時刻フォーマットを1箇所にまとめる。
 * WeekGrid と EventBlock の両方から参照するため、循環 import を避ける
 * ためだけに独立したモジュールにしてある。
 */

export const HOUR_HEIGHT = 48
export const DAY_HEIGHT = HOUR_HEIGHT * 24
export const PX_PER_MINUTE = HOUR_HEIGHT / 60

/**
 * 日列内のイベント配置(カスケード表示、フェーズ5)の左右ガター。
 * 予定が日の仕切り線に密着しないよう、列の内側にこの px 分だけ余白を持たせる
 * (WeekGrid のカスケード列計算は 0-100% の「使用可能幅」基準で行い、
 * EventBlock 側でこの px インセットと組み合わせて calc() する)
 */
export const DAY_COLUMN_INSET_PX = 3

export function minutesToPx(minutes: number): number {
  return minutes * PX_PER_MINUTE
}

export function pxToMinutes(px: number): number {
  return px / PX_PER_MINUTE
}

export function formatTime(ms: number, timeZone: string): string {
  const zdt = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(timeZone)
  return `${zdt.hour}:${String(zdt.minute).padStart(2, '0')}`
}

/** ドラッグ中のフローティングバッジ用: 「14:00 – 15:00」形式 */
export function formatRange(startMs: number, endMs: number, timeZone: string): string {
  return `${formatTime(startMs, timeZone)} – ${formatTime(endMs, timeZone)}`
}

/** WeekGrid の曜日ヘッダーと EventBlock の詳細ポップオーバーで共有する曜日ラベル */
export const WEEKDAY_LABELS = ['月', '火', '水', '木', '金', '土', '日'] as const

/** 詳細ポップオーバー用: 「7月20日(月) 10:00 – 11:00」形式 (曜日込み) */
export function formatDetailDateTime(startMs: number, endMs: number, timeZone: string): string {
  const start = Temporal.Instant.fromEpochMilliseconds(startMs).toZonedDateTimeISO(timeZone)
  const dateLabel = `${start.month}月${start.day}日(${WEEKDAY_LABELS[start.dayOfWeek - 1]})`
  return `${dateLabel} ${formatRange(startMs, endMs, timeZone)}`
}
