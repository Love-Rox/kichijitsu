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
 *
 * 2026-07-30 追記: 同じ理由でもう1段 ―― 「その日のレールに乗る帯を1本の列へ統合して列
 * パッキングする」ところ(packDayRailBands、下記)も DayColumn.tsx から移してきた。DOM に
 * 依存しない純粋な列計算で、かつ終日の不在(全高ライン)が他の帯と重なるという不具合の
 * 修正箇所だったため、テストで固定できる位置に置く必要があった。
 */

import type { Positioned } from "./packColumns";
import { packRailBandColumns } from "./railStack";

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

/**
 * 列パッキングに必要な最小の形。RailItem<S> はこれを満たす(この層は subject を見ない)。
 * 素の値でテストできるよう、あえて RailItem そのものを要求しない。
 */
export interface RailSpan {
  id: string;
  startMinutes: number;
  endMinutes: number;
}

/**
 * 1日ぶんのレールに乗る帯1本。描画時の見た目(塗り・上端の飾り)が違うだけなので、
 * レイアウト計算に必要な時刻と、描画で使う元項目を kind で判別できる形にして持つ。
 */
export type DayRailBand<O extends RailSpan, W extends RailSpan> =
  | { kind: "ooo"; id: string; startMinutes: number; endMinutes: number; oooItem: O }
  | { kind: "workloc"; id: string; startMinutes: number; endMinutes: number; workLocItem: W };

/**
 * その日のレール(不在 + 勤務場所)に乗る帯を1本の列へ統合して列パッキングする。
 *
 * ■ 2026-07-30 修正: 終日の不在(全高ライン)もこのパッキングを通す
 * それ以前、DayColumn.tsx は終日の不在だけをパッキングの対象外にして常に left: 0 へ描いて
 * いた。時刻の帯(勤務場所の区間・部分的な不在)も列0から使うため、**同じ日に両方あると
 * 必ず重なって**どちらも読めなくなっていた(勤務場所を1日ぶんの区間として描くようになった
 * 2026-07-29 以降、レールに帯が出る日が増えて遭遇率が上がった)。
 *
 * 全高ラインは元から [0, 1440] という「1日を覆う時刻範囲」を持っている
 * (oooRail.ts の allDayOooRailItems)ので、時刻の帯と同じ形のまま渡せる ―― 特別扱いを
 * やめるだけで済み、パッキング側 (railStack.ts) は一切変えていない。
 *
 * この変更で見え方が変わるのは **終日の不在がある日だけ**(その日は列が1本増えるぶん
 * 予定カードが右へずれる)。終日の不在が無い日は入力配列がこれまでと一字一句同じになるため、
 * 列の割り当ても列数も不変 ―― railItems.test.ts でその不変を固定してある。
 *
 * ■ 並び順(タイのときにどちらが列0になるか)
 * 列の割り当ては railStack.ts → packColumns.ts の「開始が早い順、同じ開始なら実効長が
 * 長い順」で決まり、完全にタイのときだけ入力配列の順序(安定ソート)が効く。
 * 呼び出し元 (DayColumn.tsx) は「全高ライン → 時刻の不在 → 勤務場所」の順で渡す約束で、
 * 全高ラインが列0(レールの左端)に来る ―― 1日を丸ごと覆う情報を最も外側に置く。
 */
export function packDayRailBands<O extends RailSpan, W extends RailSpan>(
  oooItems: readonly O[],
  workingLocationItems: readonly W[],
  hourHeight: number,
): Positioned<DayRailBand<O, W>>[] {
  const bands: DayRailBand<O, W>[] = [
    ...oooItems.map(
      (oooItem): DayRailBand<O, W> => ({
        kind: "ooo",
        id: oooItem.id,
        startMinutes: oooItem.startMinutes,
        endMinutes: oooItem.endMinutes,
        oooItem,
      }),
    ),
    ...workingLocationItems.map(
      (workLocItem): DayRailBand<O, W> => ({
        kind: "workloc",
        id: workLocItem.id,
        startMinutes: workLocItem.startMinutes,
        endMinutes: workLocItem.endMinutes,
        workLocItem,
      }),
    ),
  ];
  return packRailBandColumns(
    bands,
    (b) => b.startMinutes,
    (b) => b.endMinutes,
    hourHeight,
  );
}

/**
 * パッキング結果から、その日のレールに必要な列数を求める(帯が1本も無ければ 0)。
 * 呼び出し元はこれに RAIL_BAND_WIDTH_PX を掛けてレール幅とし、gridMetrics.ts の
 * dayColumnLeftInsetPx へ渡して予定カードの左インセットを決める。
 *
 * 非空なら必ず 1 以上になる(クラスタの columnCount は最低1)が、Math.max の下限を
 * 明示しておく ―― 「帯があるのにレール幅0」だけは起こしてはいけない不変条件のため。
 */
export function railBandColumnCount(packed: readonly Positioned<unknown>[]): number {
  if (packed.length === 0) return 0;
  return Math.max(1, ...packed.map((p) => p.columnCount));
}
