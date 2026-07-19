import { Temporal } from '@js-temporal/polyfill'
import type { GoogleEventDTO } from '@kichijitsu/shared'
import type { EventSeries, InstanceOverride } from '../model/series'
import { instanceId } from '../model/series'
import type { Occurrence } from '../model/types'

/**
 * Google Calendar の event DTO を kichijitsu のローカルモデルへ変換する純関数層。
 * サーバー (apps/sync) はイベント本体を保存しない設計のため、正規化・展開の
 * 責務は全てこことその先 (expandSeries) がクライアント側で負う。
 *
 * id 規則(マルチアカウント対応 2026-07-19): Google 由来は全て
 * `g:<accountId>:<calendarId>:<event.id>`。同じ予定が複数のカレンダーに
 * 同じ event.id で現れうる(共有予定・他人のカレンダーへの招待コピー等)ため、
 * event.id 単体では衝突する — (accountId, calendarId) をキーに含めて防ぐ。
 * - 単発 occurrence: `g:<accountId>:<calendarId>:<event.id>`
 * - シリーズ (繰り返しの親): 同上 (親自身の id がそのままシリーズ id)
 * - 例外インスタンスの override: seriesId は `g:<accountId>:<calendarId>:<recurringEventId>`、
 *   override 自身の id は instanceId() 規則 (`${seriesId}:${originalStartMs}`)
 *
 * 個々のイベント変換は失敗しても throw しない: 1件の異常が同期全体を
 * 巻き込まないよう、失敗したイベント/行は console.warn してスキップする。
 */
export interface MappedSync {
  series: EventSeries[]
  overrides: InstanceOverride[]
  singles: Occurrence[]
  /** 単発イベントが cancelled になった場合の occurrence id */
  deletedSingleIds: string[]
  /** 終日 (start.date のみ) でスキップした件数。UI が終日予定に未対応なため */
  skippedAllDay: number
}

/** mapGoogleEvents の呼び出しごとのコンテキスト: どのアカウント・どのカレンダーの同期か */
export interface MapGoogleContext {
  accountId: string
  calendarId: string
  /** カレンダー自体の色 (Google の backgroundColor)。イベント個別 colorId が無いときのフォールバック */
  defaultColor?: string
}

/** id 規則: `g:<accountId>:<calendarId>:<eventId>` */
function eventKey(ctx: MapGoogleContext, eventId: string): string {
  return `g:${ctx.accountId}:${ctx.calendarId}:${eventId}`
}

/**
 * Google Calendar のイベント色 (colorId "1".."11") から kichijitsu の hex へのマップ。
 * 値は Google Calendar の公式パレットに準拠 (アプリの既存 COLORS 系統に近い色相)。
 */
const GOOGLE_COLOR_MAP: Record<string, string> = {
  '1': '#7986cb', // Lavender
  '2': '#33b679', // Sage
  '3': '#8e24aa', // Grape
  '4': '#e67c73', // Flamingo
  '5': '#f6bf26', // Banana
  '6': '#f4511e', // Tangerine
  '7': '#039be5', // Peacock
  '8': '#616161', // Graphite
  '9': '#3f51b5', // Blueberry
  '10': '#0b8043', // Basil
  '11': '#d50000', // Tomato
}
const DEFAULT_COLOR = '#3b82f6'

/**
 * 色の決定順位: イベント個別 colorId があればそれ(Google 公式パレット)、
 * 無ければカレンダー自体の色 (ctx.defaultColor、Google の backgroundColor)、
 * それも無ければ最終フォールバックの DEFAULT_COLOR。
 * colorId が未知の値の場合もカレンダー色へフォールバックする(決め打ちの
 * DEFAULT_COLOR よりカレンダー色の方がユーザーの意図に近いため)。
 */
function colorFor(colorId: string | undefined, ctx: MapGoogleContext): string {
  if (colorId) {
    const mapped = GOOGLE_COLOR_MAP[colorId]
    if (mapped) return mapped
  }
  return ctx.defaultColor ?? DEFAULT_COLOR
}

function durationMinutesBetween(startIso: string, endIso: string): number {
  const startMs = Temporal.Instant.from(startIso).epochMilliseconds
  const endMs = Temporal.Instant.from(endIso).epochMilliseconds
  return (endMs - startMs) / 60_000
}

/** "20260720T100000Z" (UTC) または "20260720T100000" (timeZone のローカル壁時計) を epoch ms に */
function parseExdateValue(value: string, timeZone: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value)
  if (!m) {
    throw new Error(`unrecognized EXDATE value: "${value}"`)
  }
  const [, y, mo, d, h, mi, s, z] = m
  const fields = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: Number(s),
  }
  if (z) {
    return Temporal.ZonedDateTime.from({ timeZone: 'UTC', ...fields }).toInstant().epochMilliseconds
  }
  return Temporal.PlainDateTime.from(fields).toZonedDateTime(timeZone).epochMilliseconds
}

/**
 * "EXDATE;TZID=Asia/Tokyo:20260720T100000" や "EXDATE:20260720T100000Z"、
 * カンマ区切りの複数値に対応する。
 */
function parseExdateLine(line: string, defaultTimeZone: string): number[] {
  const colonIdx = line.indexOf(':')
  if (colonIdx === -1) {
    throw new Error(`no ':' in EXDATE line: "${line}"`)
  }
  const header = line.slice(0, colonIdx)
  const valuesRaw = line.slice(colonIdx + 1)
  const tzidMatch = /;TZID=([^;]+)/.exec(header)
  const timeZone = tzidMatch ? tzidMatch[1] : defaultTimeZone

  const values = valuesRaw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
  if (values.length === 0) {
    throw new Error(`EXDATE line has no values: "${line}"`)
  }
  return values.map((v) => parseExdateValue(v, timeZone))
}

function originalStartMsOf(event: GoogleEventDTO): number {
  const ost = event.originalStartTime
  if (!ost) {
    throw new Error(`event ${event.id} is an exception instance but has no originalStartTime`)
  }
  if (ost.dateTime) {
    return Temporal.Instant.from(ost.dateTime).epochMilliseconds
  }
  if (ost.date) {
    const timeZone = ost.timeZone ?? 'UTC'
    return Temporal.PlainDate.from(ost.date).toZonedDateTime(timeZone).epochMilliseconds
  }
  throw new Error(`event ${event.id} originalStartTime has neither dateTime nor date`)
}

/** 繰り返しの親イベント → EventSeries。RRULE 行が見つからなければ null (呼び出し側で warn 済み) */
function buildSeries(event: GoogleEventDTO, ctx: MapGoogleContext): EventSeries | null {
  if (!event.start?.dateTime || !event.end?.dateTime) {
    throw new Error(`series event ${event.id} missing start/end dateTime`)
  }
  const timeZone = event.start.timeZone ?? 'UTC'
  const dtstartIso = event.start.dateTime.slice(0, 16)
  const durationMin = durationMinutesBetween(event.start.dateTime, event.end.dateTime)

  let rruleLine: string | undefined
  const exdatesMs: number[] = []

  for (const line of event.recurrence ?? []) {
    if (line.startsWith('RRULE:')) {
      if (rruleLine !== undefined) {
        console.warn(
          `mapGoogleEvents: event ${event.id} has multiple RRULE lines, ignoring extra: "${line}"`,
        )
        continue
      }
      rruleLine = line.slice('RRULE:'.length)
    } else if (line.startsWith('EXDATE')) {
      try {
        exdatesMs.push(...parseExdateLine(line, timeZone))
      } catch (err) {
        console.warn(`mapGoogleEvents: event ${event.id} failed to parse EXDATE line "${line}"`, err)
      }
    } else {
      console.warn(`mapGoogleEvents: event ${event.id} has unsupported recurrence line, skipping: "${line}"`)
    }
  }

  if (rruleLine === undefined) {
    console.warn(`mapGoogleEvents: event ${event.id} has recurrence but no RRULE line, skipping series`)
    return null
  }

  return {
    id: eventKey(ctx, event.id),
    title: event.summary ?? '(無題)',
    color: colorFor(event.colorId, ctx),
    source: 'google',
    accountId: ctx.accountId,
    calendarId: ctx.calendarId,
    location: event.location,
    description: event.description,
    ...(event.htmlLink ? { link: { url: event.htmlLink } } : {}),
    dtstartIso,
    timeZone,
    durationMin,
    rrule: rruleLine,
    exdatesMs,
  }
}

/** 例外インスタンス (recurringEventId あり) → InstanceOverride */
function buildOverride(event: GoogleEventDTO, ctx: MapGoogleContext): InstanceOverride {
  if (!event.recurringEventId) {
    throw new Error(`override event ${event.id} missing recurringEventId`)
  }
  const seriesId = eventKey(ctx, event.recurringEventId)
  const originalStartMs = originalStartMsOf(event)

  if (event.status === 'cancelled') {
    return { id: instanceId(seriesId, originalStartMs), seriesId, originalStartMs, patch: null }
  }

  if (!event.start?.dateTime || !event.end?.dateTime) {
    throw new Error(`override event ${event.id} missing start/end dateTime`)
  }

  const patch: NonNullable<InstanceOverride['patch']> = {
    startMs: Temporal.Instant.from(event.start.dateTime).epochMilliseconds,
    endMs: Temporal.Instant.from(event.end.dateTime).epochMilliseconds,
  }
  if (event.summary !== undefined) {
    patch.title = event.summary
  }
  if (event.location !== undefined) {
    patch.location = event.location
  }
  if (event.description !== undefined) {
    patch.description = event.description
  }

  return { id: instanceId(seriesId, originalStartMs), seriesId, originalStartMs, patch }
}

/** 単発イベント → Occurrence。start/end.dateTime は呼び出し側で存在確認済み */
function buildSingle(
  event: GoogleEventDTO,
  startDateTime: string,
  endDateTime: string,
  ctx: MapGoogleContext,
): Occurrence {
  return {
    id: eventKey(ctx, event.id),
    seriesId: null,
    title: event.summary ?? '(無題)',
    startMs: Temporal.Instant.from(startDateTime).epochMilliseconds,
    endMs: Temporal.Instant.from(endDateTime).epochMilliseconds,
    color: colorFor(event.colorId, ctx),
    source: 'google',
    accountId: ctx.accountId,
    calendarId: ctx.calendarId,
    location: event.location,
    description: event.description,
    ...(event.htmlLink ? { link: { url: event.htmlLink } } : {}),
  }
}

export function mapGoogleEvents(events: GoogleEventDTO[], ctx: MapGoogleContext): MappedSync {
  const series: EventSeries[] = []
  const overrides: InstanceOverride[] = []
  const singles: Occurrence[] = []
  const deletedSingleIds: string[] = []
  let skippedAllDay = 0

  for (const event of events) {
    try {
      // 終日 (date のみ、dateTime なし) は UI 未対応のため常にスキップ
      if (event.start?.date && !event.start?.dateTime) {
        skippedAllDay++
        continue
      }

      if (event.recurrence && event.recurrence.length > 0) {
        const built = buildSeries(event, ctx)
        if (built) series.push(built)
        continue
      }

      if (event.recurringEventId) {
        overrides.push(buildOverride(event, ctx))
        continue
      }

      // 単発
      if (!event.start?.dateTime || !event.end?.dateTime) {
        console.warn(`mapGoogleEvents: event ${event.id} has no usable start/end, skipping`, event)
        continue
      }
      if (event.status === 'cancelled') {
        deletedSingleIds.push(eventKey(ctx, event.id))
        continue
      }
      singles.push(buildSingle(event, event.start.dateTime, event.end.dateTime, ctx))
    } catch (err) {
      console.warn(`mapGoogleEvents: failed to convert event ${event.id}, skipping`, err)
    }
  }

  if (skippedAllDay > 0) {
    console.info(`mapGoogleEvents: skipped ${skippedAllDay} all-day event(s) (not supported yet)`)
  }

  return { series, overrides, singles, deletedSingleIds, skippedAllDay }
}
