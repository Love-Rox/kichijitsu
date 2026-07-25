/**
 * 日列端レール(不在 OOO / 勤務場所)の項目生成の generic 層(2026-07-26 リファクタ フェーズ3a)。
 *
 * なぜ generic にしたか: oooRail.ts の timedOooRailItems と workingLocationRail.ts の
 * timedWorkingLocationRailItems は、コメントが自認していたとおり本体が完全に一致していた
 * (「その日ぶんに絞り込み済みの group を [dayStartMs, dayEndMs) にクリップして分オフセットへ
 * 変換し、高さ0にならないよう最低1分ぶんを確保する」)。同じロジックが2本あると片方だけ直す
 * 事故が起きるため、subject の型だけをパラメータにした1本へ寄せた ―― OOO と勤務場所で違うのは
 * 「どの group を渡すか」(振り分け条件)と「描画時の見た目」だけで、レイアウト計算は同一という
 * 事実をそのまま型に写した形。
 */

/** レール項目1本ぶん。subject の型 S だけが OOO(時刻|終日)と勤務場所(時刻のみ)で異なる */
export interface RailItem<S> {
  /** レール描画・詳細ポップオーバーの React key */
  id: string;
  subject: S;
  /** 集約グループの全メンバー。EventDetailCard の groupMembers にそのまま渡す */
  groupMembers: S[];
  /** その日の 0:00 からのオフセット(分) */
  startMinutes: number;
  endMinutes: number;
}

/** railItemsForDay が必要とする最小の subject 形状(時刻を持つ occurrence) */
interface TimedSubject {
  id: string;
  startMs: number;
  endMs: number;
}

/**
 * 時刻予定の group を [dayStartMs, dayEndMs) にクリップしてレール項目化する。
 *
 * 呼び出し元 (WeekGrid.tsx) は既にその日ぶんに絞り込んだ occurrence だけを渡す前提
 * (通常の時刻予定と同じ日別フィルタを経由済み)なので通常はクリップは効かないが、
 * 万一日をまたぐ予定が来てもレールが日列の外へはみ出さないよう保険をかけておく。
 */
export function railItemsForDay<T extends TimedSubject>(
  groups: readonly { primary: T; members: T[] }[],
  dayStartMs: number,
  dayEndMs: number,
): RailItem<T>[] {
  const out: RailItem<T>[] = [];
  for (const g of groups) {
    const occ = g.primary;
    if (occ.startMs >= dayEndMs || occ.endMs <= dayStartMs) continue; // この日と無関係
    const clippedStartMs = Math.max(occ.startMs, dayStartMs);
    const clippedEndMs = Math.min(occ.endMs, dayEndMs);
    const startMinutes = (clippedStartMs - dayStartMs) / 60_000;
    // 高さ0の帯は見えなくなるので、クリップ後も最低1分ぶんは確保する
    const endMinutes = Math.max((clippedEndMs - dayStartMs) / 60_000, startMinutes + 1);
    out.push({ id: occ.id, subject: occ, groupMembers: g.members, startMinutes, endMinutes });
  }
  return out;
}
