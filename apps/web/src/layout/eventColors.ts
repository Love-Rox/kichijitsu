/**
 * イベントの表示色解決とハッチ/ストライプ生成の純粋関数群 (フェーズ6: Busy のカレンダー色
 * ハッチ化 + 集約カードのカレンダー色ストライプ)。DOM/React に依存しないため EventBlock.tsx
 * から呼ばれる薄いロジック層としてここに切り出し、単体テストしやすくしてある。
 *
 * CalendarInfo (EventBlock.tsx) を直接 import すると循環参照になるため、
 * 必要なフィールドだけを構造的に受け取る形にしてある。
 */

export interface ColorLookupTarget {
  accountId?: string;
  calendarId?: string;
  color: string;
  /**
   * true ならこの color はイベント個別色 (Google colorId 由来) なので表示時も
   * そのまま尊重する。false/undefined なら color は同期時点のフォールバック
   * 焼き込み値に過ぎないため、resolveDisplayColor は calendarLookup のカレンダー色を
   * 優先する(Occurrence.hasCustomColor / AllDayOccurrence.hasCustomColor 参照)。
   */
  hasCustomColor?: boolean;
}

export interface CalendarColorInfo {
  backgroundColor?: string;
}

/** Busy プレースホルダの色が解決できない/不正なときのフォールバック(従来の一律グレー) */
export const BUSY_FALLBACK_COLOR = "#c9c2b4";

/** カレンダー色が未解決/不正なときの中立フォールバック(EventDetailCard の既存デフォルトと揃える) */
export const UNKNOWN_CALENDAR_COLOR = "#9ca3af";

/** 集約ストライプの既定上限本数。超過分は最後の1本にまとめる */
const DEFAULT_MAX_STRIPES = 5;

const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const CSS_COLOR_FUNCTION_RE = /^(rgb|rgba|hsl|hsla)\(/i;

/**
 * occurrence.color / calendarLookup 由来の色が実際に CSS へそのまま渡せる形式か。
 * hex (#rgb / #rrggbb) と rgb()/rgba()/hsl()/hsla() 関数記法のみを妥当とみなす
 * (このアプリで実際に使われる色はこのどちらか)。空文字・undefined・不明な文字列は不正。
 */
export function isValidCssColor(color: string | undefined | null): color is string {
  if (!color) return false;
  const trimmed = color.trim();
  if (trimmed.length === 0) return false;
  return HEX_COLOR_RE.test(trimmed) || CSS_COLOR_FUNCTION_RE.test(trimmed);
}

/**
 * `${accountId}:${calendarId}` キーで calendarLookup を引き、カレンダー色があればそれを、
 * 無ければ occurrence 自身の color を返す(event-group-dots 等で使っていた解決順序と同じ)。
 */
export function resolveEventColor(
  target: ColorLookupTarget,
  calendarLookup: Map<string, CalendarColorInfo>,
): string {
  const info =
    target.accountId && target.calendarId
      ? calendarLookup.get(`${target.accountId}:${target.calendarId}`)
      : undefined;
  return info?.backgroundColor ?? target.color;
}

/**
 * 表示色の解決順位 (色バグ修正 2026-07-20): イベント個別色 (hasCustomColor) が
 * あればそれを尊重してそのまま使う。無ければカレンダー色を優先する resolveEventColor
 * に委ねる (calendarLookup のカレンダー色 → 無ければ occurrence.color)。
 *
 * 背景: occurrence.color は同期時に colorFor() で焼き込まれるスナップショットで、
 * カレンダー一覧取得より先に初回同期が走ると ctx.defaultColor が未定義のまま
 * デフォルト色が焼き込まれてしまう(祝日カレンダー等で顕著)。hasCustomColor が
 * false の occurrence は render 時に毎回このロジックでカレンダー色を再解決する
 * ことで、焼き込み時点のズレを再同期無しに解消する。EventBlock/AllDayBar の
 * 表示色(背景・左ボーダー・Busy ハッチ・集約ストライプ)は全てこれを経由すること。
 */
export function resolveDisplayColor(
  target: ColorLookupTarget,
  calendarLookup: Map<string, CalendarColorInfo>,
): string {
  if (target.hasCustomColor) return target.color;
  return resolveEventColor(target, calendarLookup);
}

/**
 * Busy プレースホルダの左ボーダー/ハッチ色。resolveDisplayColor で解決した色が不正
 * (未設定・空・想定外のフォーマット)なら従来のグレーにフォールバックする。
 */
export function resolveBusyColor(
  target: ColorLookupTarget,
  calendarLookup: Map<string, CalendarColorInfo>,
): string {
  const resolved = resolveDisplayColor(target, calendarLookup);
  return isValidCssColor(resolved) ? resolved : BUSY_FALLBACK_COLOR;
}

/**
 * 集約カード(同一予定が複数カレンダーに存在するグループ)の左端に並べる色ストライプ。
 * 各メンバーのカレンダー色を順番通りに解決し、maxStripes 本を超える場合は
 * 先頭 (maxStripes - 1) 本だけ実色を残し、最後の1本を UNKNOWN_CALENDAR_COLOR で
 * 「それ以上ある」ことを示すまとめ表示にする。不正な色は都度 UNKNOWN_CALENDAR_COLOR に丸める。
 */
export function buildCalendarStripeColors(
  members: readonly ColorLookupTarget[],
  calendarLookup: Map<string, CalendarColorInfo>,
  maxStripes: number = DEFAULT_MAX_STRIPES,
): string[] {
  const colors = members.map((member) => {
    const resolved = resolveDisplayColor(member, calendarLookup);
    return isValidCssColor(resolved) ? resolved : UNKNOWN_CALENDAR_COLOR;
  });
  if (colors.length <= maxStripes) return colors;
  return [...colors.slice(0, maxStripes - 1), UNKNOWN_CALENDAR_COLOR];
}
