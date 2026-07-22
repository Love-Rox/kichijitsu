import type { Occurrence } from "../model/types";
import { isBusyPlaceholder } from "./gridMetrics";
import { isOutOfOffice } from "./oooRail";

/**
 * 場所付き予定レール表示(地図ピン、2026-07-22)の DOM/React に依存しない純関数層。
 * oooRail.ts と同じ流儀(WeekGrid.tsx から呼ばれる薄いロジック層をここへ切り出し、
 * 単体テストしやすくする)。
 *
 * 要件: location(会議室・住所・URL 等)を持つ時刻予定について、不在(OOO)レールと同じ
 * 「日カラム左端のレールに開始時刻の位置で並べる」体験を提供する。ただし OOO と違って
 * 予定カード自体は消さない(場所付き予定は実在の予定のため) ―― これはカードの隣に立つ
 * 補助的な目印なので、対象抽出はここで行うが、packColumns の入力(カード側のカスケード)
 * には一切影響しない(oooRail.ts の splitOutOfOfficeGroups のような「除外」は不要)。
 */

/**
 * この occurrence がレール表示の対象か。location が非空 かつ、
 *   - 不在(OOO): 既に専用レールに出るため二重に出さない
 *   - Busy プレースホルダ(isBusyPlaceholder(title)): 中身の無いブロックなので対象外
 *   - 勤務場所(isWorkingLocation): 控えめ表示の専用扱いが既にあるため対象外
 * のいずれでもないもの。オンライン会議 (hasConference) は対象外にしない ―― location と
 * hasConference は独立した項目で、location があれば(会議リンクの有無に関わらず)対象になる
 * (ユーザー決定:「オンライン会議はこの対象外」は VideoIcon 側の話であり、location 表示とは別軸)。
 */
export function isLocationRailCandidate(occurrence: Occurrence): boolean {
  if (!occurrence.location) return false;
  if (isOutOfOffice(occurrence)) return false;
  if (isBusyPlaceholder(occurrence.title)) return false;
  if (occurrence.isWorkingLocation === true) return false;
  return true;
}

/** DayColumn の場所付き予定レールに描画する1本(1ピン)ぶんのデータ */
export interface LocationRailItem {
  /** レール描画・詳細ポップオーバーの React key */
  id: string;
  /** その日の 0:00 からのオフセット(分)。日をまたぐ予定はその日の 0:00 にクリップする */
  startMinutes: number;
  subject: Occurrence;
}

/**
 * 時刻予定の配列から、その日ぶんの場所付き予定レール項目を作る。
 * oooRail.ts の timedOooRailItems と同じ「[dayStartMs, dayEndMs) と無関係なものを除外し、
 * 日をまたぐ場合は開始側だけ日の 0:00 にクリップする」考え方に倣う(ピンは開始時刻1点だけを
 * 表すため、終了側のクリップは不要 ―― timedOooRailItems と異なりここでは endMinutes を持たない)。
 *
 * 呼び出し元 (WeekGrid.tsx) は OOO レールと同じ「その日ぶんに絞り込み済みの occurrence」を渡す
 * 想定(通常は cardGroups の primary 群)。timeZone は分オフセット計算に使わない(dayStartMs/
 * dayEndMs は既に呼び出し元が対象タイムゾーンで壁時計境界を epoch ms へ変換済みのため、この純
 * 関数側では ms の差分だけで足りる ―― oooRail.ts の各関数も同じ理由で timeZone を取らない)。
 */
export function locationRailItems(
  occurrences: readonly Occurrence[],
  dayStartMs: number,
  dayEndMs: number,
): LocationRailItem[] {
  const out: LocationRailItem[] = [];
  for (const occ of occurrences) {
    if (!isLocationRailCandidate(occ)) continue;
    if (occ.startMs >= dayEndMs || occ.endMs <= dayStartMs) continue; // この日と無関係
    const clippedStartMs = Math.max(occ.startMs, dayStartMs);
    const startMinutes = (clippedStartMs - dayStartMs) / 60_000;
    out.push({ id: occ.id, startMinutes, subject: occ });
  }
  return out;
}
