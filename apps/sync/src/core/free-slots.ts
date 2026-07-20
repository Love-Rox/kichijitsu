/**
 * MCP `suggest_free_slots` ツール (docs/mcp.md) の空き時間計算本体。busy interval の集合と
 * 期間・所要時間から、その期間内で会議を置ける候補を gap ごとに複数返す純関数。各 gap の
 * 先頭から stepMinutes 刻みで候補をずらしながら列挙し、全 gap 合計で maxCandidates 件に
 * 達したら打ち切る (候補は時系列順に列挙するので「最も早い順に N 件」になる)。
 *
 * timeZone は受け取るが現状未使用 (TODO): 日境界の計算は UTC ベースの単純な実装であり、
 * タイムゾーンごとの正しい日境界には @js-temporal/polyfill 相当が必要 (今回のタスクの
 * スコープ外、docs/mcp.md 参照)。
 */

export interface BusyInterval {
  startMs: number;
  endMs: number;
}

export interface FreeSlot {
  startMs: number;
  endMs: number;
}

/** 0-24 の UTC ベースの時刻 (例: startHour=9, endHour=18 で 09:00-18:00 UTC)。 */
export interface WorkingHours {
  startHour: number;
  endHour: number;
}

export interface ComputeFreeSlotsInput {
  busy: BusyInterval[];
  rangeStartMs: number;
  rangeEndMs: number;
  durationMs: number;
  workingHours?: WorkingHours;
  timeZone?: string;
  /** 候補を gap 内でずらす刻み幅 (分)。省略時 30。 */
  stepMinutes?: number;
  /** 全 gap 合計で返す候補数の上限 (gap ごとの上限ではない)。省略時 10。 */
  maxCandidates?: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;
const DEFAULT_STEP_MINUTES = 30;
const DEFAULT_MAX_CANDIDATES = 10;

export function computeFreeSlots(input: ComputeFreeSlotsInput): FreeSlot[] {
  const { busy, rangeStartMs, rangeEndMs, durationMs, workingHours } = input;
  const stepMinutes = input.stepMinutes ?? DEFAULT_STEP_MINUTES;
  const maxCandidates = input.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  if (rangeStartMs >= rangeEndMs || durationMs <= 0 || stepMinutes <= 0 || maxCandidates <= 0) {
    return [];
  }

  const merged = mergeClippedBusyIntervals(busy, rangeStartMs, rangeEndMs);
  const gaps = computeGaps(merged, rangeStartMs, rangeEndMs);
  const restrictedGaps = workingHours
    ? gaps.flatMap((gap) => splitByWorkingHours(gap, workingHours))
    : gaps;

  const stepMs = stepMinutes * 60_000;
  const slots: FreeSlot[] = [];
  for (const gap of restrictedGaps) {
    let cursor = gap.startMs;
    while (cursor + durationMs <= gap.endMs) {
      slots.push({ startMs: cursor, endMs: cursor + durationMs });
      if (slots.length >= maxCandidates) return slots;
      cursor += stepMs;
    }
  }
  return slots;
}

/** busy interval を range にクリップし、range 外に落ちる/長さ0以下のものを捨て、重なり・接する区間を統合する。 */
function mergeClippedBusyIntervals(
  busy: BusyInterval[],
  rangeStartMs: number,
  rangeEndMs: number,
): BusyInterval[] {
  const clipped = busy
    .map((interval) => ({
      startMs: Math.max(interval.startMs, rangeStartMs),
      endMs: Math.min(interval.endMs, rangeEndMs),
    }))
    .filter((interval) => interval.startMs < interval.endMs)
    .sort((a, b) => a.startMs - b.startMs);

  const merged: BusyInterval[] = [];
  for (const interval of clipped) {
    const last = merged[merged.length - 1];
    if (last && interval.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, interval.endMs);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/** マージ済み busy interval の間・前後にある空き区間を左から右へ列挙する。 */
function computeGaps(merged: BusyInterval[], rangeStartMs: number, rangeEndMs: number): FreeSlot[] {
  const gaps: FreeSlot[] = [];
  let cursor = rangeStartMs;
  for (const interval of merged) {
    if (interval.startMs > cursor) {
      gaps.push({ startMs: cursor, endMs: interval.startMs });
    }
    cursor = Math.max(cursor, interval.endMs);
  }
  if (cursor < rangeEndMs) {
    gaps.push({ startMs: cursor, endMs: rangeEndMs });
  }
  return gaps;
}

/** 1つの gap を、それが重なる各 UTC 暦日の working hours window と交差させ、正の長さを持つ部分だけ残す。 */
function splitByWorkingHours(gap: FreeSlot, workingHours: WorkingHours): FreeSlot[] {
  const subGaps: FreeSlot[] = [];
  const firstDayStartMs = Math.floor(gap.startMs / MS_PER_DAY) * MS_PER_DAY;

  for (let dayStartMs = firstDayStartMs; dayStartMs < gap.endMs; dayStartMs += MS_PER_DAY) {
    const windowStartMs = dayStartMs + workingHours.startHour * MS_PER_HOUR;
    const windowEndMs = dayStartMs + workingHours.endHour * MS_PER_HOUR;

    const intersectionStartMs = Math.max(gap.startMs, windowStartMs);
    const intersectionEndMs = Math.min(gap.endMs, windowEndMs);
    if (intersectionStartMs < intersectionEndMs) {
      subGaps.push({ startMs: intersectionStartMs, endMs: intersectionEndMs });
    }
  }

  return subGaps;
}
