import { GOOGLE_COLOR_MAP } from "@kichijitsu/web/sync/mapGoogle";

/** Google のイベント色(colorId "1".."11")と、Google カレンダーでの呼び名。色は Web 版と同じ表を使う。 */
export const EVENT_COLORS: { id: string; name: string; hex: string }[] = [
  ["1", "ラベンダー"],
  ["2", "セージ"],
  ["3", "グレープ"],
  ["4", "フラミンゴ"],
  ["5", "バナナ"],
  ["6", "みかん"],
  ["7", "ピーコック"],
  ["8", "グラファイト"],
  ["9", "ブルーベリー"],
  ["10", "バジル"],
  ["11", "トマト"],
].map(([id, name]) => ({ id, name, hex: GOOGLE_COLOR_MAP[id] }));

/** 予定の色(hex)から colorId を引く。個別色でない・表に無いときは null(= カレンダーの色)。 */
export function colorIdOf(color: string, hasCustomColor: boolean | undefined): string | null {
  if (!hasCustomColor) return null;
  return EVENT_COLORS.find((c) => c.hex.toLowerCase() === color.toLowerCase())?.id ?? null;
}
