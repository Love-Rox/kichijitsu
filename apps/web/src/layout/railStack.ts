import { PX_PER_MINUTE, RAIL_MIN_BAND_HEIGHT_PX } from "./gridMetrics";
import { packColumns, type Positioned } from "./packColumns";

/**
 * 不在(OOO)レール・勤務場所レールの列パッキング(2026-07-22、横ずれ解消)。
 *
 * 経緯: 当初 OOO バーと勤務場所帯は別々のレールとして横に14pxずらして共存させていたが、
 * 「終了時刻==開始時刻」のような同時刻の帯が side-by-side にずれて見え、ユーザーからは
 * 「同じ左端の列に縦に並べたい」という要望が来た。最初は「重なる帯を直前の帯の下端まで
 * 押し下げる」縦パッキング案を実装したが、後の要望で「完全に重なる時間があるときは
 * 横に並んでも構わない(押し下げない)」という方針に変わった ―― つまり EventBlock の
 * カスケード表示(packColumns.ts)と全く同じ考え方: 時間が重ならない帯どうしは同じ列
 * (x=0)に本来の時刻位置のまま乗せて縦に並べ、時間が重なる帯どうしだけ列を分けて
 * 横に並べる。押し下げ(縦位置の書き換え)は一切行わない。
 *
 * このファイルは packColumns.ts の貪欲 first-fit 列詰めをそのまま流用する薄いラッパー。
 * 独自の列割当アルゴリズムを再実装しない ―― EventBlock のカスケードと「重なったら列を
 * 分ける」という判定基準を統一しておいたほうが挙動の予測がしやすいため。
 */

/**
 * 長さ0(start===end)や数分の短い帯は、表示上 RAIL_MIN_BAND_HEIGHT_PX(16px)ぶんの
 * 高さを占める(OooRailLine.tsx/WorkingLocationRailBand.tsx が Math.max(実高さ, 16px) で
 * 描画するため)。この「見た目の下限」を無視して実時間だけで重なり判定すると、
 * 例えば同時刻(start===end)の OOO と勤務場所が「重なっていない」と判定されて同じ列
 * (縦)に置かれてしまい、結局は視覚的に重なる(どちらも16px分の矩形を同じ位置に描く)。
 * それを避けるため、列パッキングの重なり判定だけは各帯の終了時刻を
 * 「max(実終了, 開始 + MIN_BAND_MINUTES)」に底上げした「実効終了時刻」で行う。
 * 底上げは重なり判定にのみ使い、実際の描画位置(top/height)には一切影響しない
 * (呼び出し側 DayColumn.tsx は本来の startMinutes/endMinutes から top/height を計算する)。
 */
const MIN_BAND_MINUTES = RAIL_MIN_BAND_HEIGHT_PX / PX_PER_MINUTE;

function effectiveEndMinutes(startMinutes: number, endMinutes: number): number {
  return Math.max(endMinutes, startMinutes + MIN_BAND_MINUTES);
}

/**
 * OOO レール・勤務場所レールの帯を列パッキングする。packColumns.ts と同じ
 * Positioned<T>(item/column/columnCount)を返すので、呼び出し側(DayColumn.tsx)は
 * `column * RAIL_BAND_WIDTH_PX` で left を、`Math.max(1, columnCount)`(0件なら呼ばれない
 * 想定)で日のレール全体の必要幅を求める。
 *
 * getStartMinutes/getEndMinutes には帯の「本来の」時刻(表示上の最低高さを底上げする前の
 * 実時間)を渡すこと ―― 底上げは内部の effectiveEndMinutes が重なり判定のためだけに行う。
 *
 * 並び順: packColumns.ts の既定ソート(開始時刻昇順、同時刻なら実効終了が遅い方=長い方が
 * 先)をそのまま使う。同時刻・同じ実効長で完全にタイになった場合は Array.sort の安定性に
 * よって入力配列の順序が保たれるため、呼び出し側が「OOO を先に(勤務場所より前に)」
 * 並べて渡せば、タイのときは OOO が列0(左、カードに一番近い位置)に来る
 * (DayColumn.tsx がその順で配列を組み立てている)。
 */
export function packRailBandColumns<T>(
  items: readonly T[],
  getStartMinutes: (item: T) => number,
  getEndMinutes: (item: T) => number,
): Positioned<T>[] {
  return packColumns(items, getStartMinutes, (item) =>
    effectiveEndMinutes(getStartMinutes(item), getEndMinutes(item)),
  );
}
