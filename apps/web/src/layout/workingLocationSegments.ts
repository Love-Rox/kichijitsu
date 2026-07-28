import type { RailItem } from "./railItems";

/**
 * 1日ぶんの勤務場所 (workingLocation) を「重なりの無い区間の列」へ畳む純関数
 * (2026-07-29、ユーザー報告「勤務地について、変更が発生したときの変更前と変更後の両方が
 * 残ってしまう」の原因調査から)。
 *
 * ■ なぜ必要か(症状の正体)
 * 報告された「両方残る」は同期バグではなく **表示の問題** だった。実データを確認すると、
 * 同じ日に終日の勤務場所と時刻付きの勤務場所が両方実在する:
 *
 *   2026-07-14  終日=オフィス   時刻付き=自宅 9:30–13:00
 *   2026-07-17  終日=自宅       時刻付き=オフィス 13:00–18:00
 *
 * これは Google の勤務場所モデルそのもので、「その日の既定の場所」(終日) と「一部の時間帯
 * だけ別の場所」(時刻付き) が併存する。どちらが既定でどちらが上書きかは日によって入れ替わる
 * (7/14 は終日オフィス+時刻付き自宅、7/17 はその逆)。Google カレンダー自身は1日を区間に
 * 分割して描くので二重には見えないが、kichijitsu は終日をチップ (AllDayBar)、時刻付きを帯
 * (DayColumn のレール) として **独立に** 並べていたため「変更前と変更後が両方残っている」
 * ように見えていた。
 *
 * そこでこのモジュールが「終日=地、時刻付き=その範囲の上書き」を1日ぶんの区間列へ畳む。
 *
 * ■ 決着規則(重なったときにどちらが勝つか)
 * ペイント順に後から塗ったものが上、という単純な塗り重ね (painter's algorithm) 1本で通す:
 *
 *   1. 地 (終日) を先に [0, 1440] へ塗る
 *   2. 時刻付きを **開始が早い順、同じ開始なら終了が遅い順** に塗り重ねる
 *
 * この規則は Google 公式ガイド "Manage focus time, out of office, and working location events"
 * の "How to show overlapping working location events"
 * (https://developers.google.com/workspace/calendar/api/guides/calendar-status) が挙げる
 * 優先順位に合わせてある ―― 同ガイドは「同じ時間に複数の勤務場所が重なりうる」ことを明記した
 * うえで、クライアントの表示指針として次を示している:
 *
 *   - "Timed events take precedence over all-day events."            → 手順 1→2 の順序そのもの
 *   - "Events which start later take precedence over events which start earlier."
 *                                                                     → 開始が早い順に塗る
 *   - "Events with shorter durations take precedence over those with longer durations."
 *                                                                     → 同じ開始なら長い方を先に塗る
 *   - "Partially overlapping events should be shown as two different events each with their own
 *      working location."                                             → 重なった部分だけを削って両方残す
 *
 * 残る2つ("Single events take precedence over recurring events"、"More recently created events
 * take precedence") は採用していない。前者は Occurrence が単発かシリーズ由来かを seriesId で
 * 判別できるものの、後者に必要な作成日時をこのアプリのデータモデルが持っていないため ――
 * どちらも「開始も長さも完全に一致する2件」でしか効かない最終タイブレークで、その場合は
 * 上の安定ソートの結果(入力順)で決まる。
 *
 * 並び順を上記の向きにしたもう一つの理由は、**どの区間も完全には消えない** ことが保証される
 * 点にある(後から塗るものは必ず「開始が後」か「開始が同じで終了が早い」ので、先に塗ったものを
 * 丸ごと覆えない)。逆向き(同じ開始で終了が早い順)にすると 9:00–11:00 が 9:00–13:00 に
 * 丸ごと飲まれて画面から消え、利用者から見て予定が「無かったこと」になってしまう。
 *
 * ■ 同じ場所が隣接したときに繋げるか → 繋げない
 * 例えば地=自宅 + 時刻付き=自宅 9:00–13:00 のとき、結果は 自宅 0:00–9:00 / 自宅 9:00–13:00 /
 * 自宅 13:00–24:00 の3本になる。1本に繋げない理由は、区間が「どの予定に由来するか」
 * (subject/groupMembers) を保持していて、ホバーのツールチップとクリックの詳細ポップオーバーが
 * その予定の本来の時間帯・所属カレンダーを出すため。繋げると2つの予定のどちらを出すか決め
 * られなくなる(あるいは片方の予定へ辿り着けなくなる)。見た目の連続性は、隣接する帯が隙間
 * なく並ぶことで既に得られている。
 *
 * ■ 地が無い日 / 時刻付きが無い日
 * 地 (終日) が無ければ時刻付きの区間だけが出る ―― 空いた時間を勝手に埋めない
 * (どこで働いているかの情報がそもそも無いため)。時刻付きが無ければ地1本だけになるが、
 * その場合の描画は従来どおり終日レーンのチップに任せる(呼び出し元 WeekGrid.tsx 側の判断。
 * layout/workingLocationRail.ts の splitWorkingLocationAllDayGroups を参照)。
 */

/** 1日の分数。地 (終日の勤務場所) の区間はこの全長を占める */
export const MINUTES_PER_DAY = 24 * 60;

/** 塗り重ねの途中経過。source は「この断片の由来になった元の項目」 */
interface Piece<S> {
  source: RailItem<S>;
  startMinutes: number;
  endMinutes: number;
}

/**
 * 既存の断片列へ next を塗り重ねる。next と重なる部分は既存側から削り取る
 * (完全に覆われれば消え、内側に食い込めば前後2つに割れる)。
 */
function paint<S>(pieces: readonly Piece<S>[], next: RailItem<S>): Piece<S>[] {
  const { startMinutes: s, endMinutes: e } = next;
  const out: Piece<S>[] = [];
  for (const p of pieces) {
    if (p.endMinutes <= s || p.startMinutes >= e) {
      out.push(p); // 重ならない断片はそのまま
      continue;
    }
    // 前に残る部分 / 後ろに残る部分(両方できれば地が分断される)
    if (p.startMinutes < s) out.push({ ...p, endMinutes: s });
    if (p.endMinutes > e) out.push({ ...p, startMinutes: e });
  }
  out.push({ source: next, startMinutes: s, endMinutes: e });
  return out;
}

/**
 * 1日ぶんの勤務場所を重なりの無い区間列へ畳む。
 *
 * @param base 地(終日の勤務場所)。通常0〜1件で、範囲は [0, MINUTES_PER_DAY]。
 *             2件以上あれば後ろのものが上に来る(配列順どおりに塗り重ねる)。
 * @param overrides 時刻付きの勤務場所。呼び出し元でその日へクリップ済みであること
 *             (layout/railItems.ts の railItemsForDay を通した形)。
 * @returns 開始の早い順に並んだ、互いに重ならない区間列。id は元の項目 id と開始分から
 *          組み立てる(1つの予定が複数の区間に割れても React の key が衝突しない)。
 */
export function foldWorkingLocationDay<S>(
  base: readonly RailItem<S>[],
  overrides: readonly RailItem<S>[],
): RailItem<S>[] {
  // 開始が早い順 → 同じ開始なら終了が遅い順(冒頭コメントの決着規則)。
  // 呼び出し元の配列を破壊しないようコピーしてから並べ替える。
  const sortedOverrides = [...overrides].sort(
    (a, b) => a.startMinutes - b.startMinutes || b.endMinutes - a.endMinutes,
  );

  let pieces: Piece<S>[] = [];
  for (const item of base) pieces = paint(pieces, item);
  for (const item of sortedOverrides) pieces = paint(pieces, item);

  return pieces
    .filter((p) => p.endMinutes > p.startMinutes) // 長さ0に削られた断片は描かない
    .sort((a, b) => a.startMinutes - b.startMinutes)
    .map((p) => ({
      id: `${p.source.id}@${p.startMinutes}`,
      subject: p.source.subject,
      groupMembers: p.source.groupMembers,
      startMinutes: p.startMinutes,
      endMinutes: p.endMinutes,
    }));
}
