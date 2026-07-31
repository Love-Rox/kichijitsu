import { Temporal } from "@js-temporal/polyfill";

/**
 * 「表示タイムゾーンでの1日」を扱う共有ヘルパ(2026-07-31 横断レビュー B-4/B-5)。
 *
 * ■ なぜ1本にまとめたか
 * `day.toZonedDateTime({ timeZone }).epochMilliseconds` と `add({ days: 1 })` の組み合わせが
 * layout/viewRange.ts・layout/oooDayCoverage.ts(非 export の private 関数)・layout/monthGrid.ts
 * (2箇所)・components/WeekGrid.tsx(2箇所)・sync/eventEdit.ts(2箇所)に写経されていて、
 * 逆向き(epoch ms → その日の PlainDate)も5箇所に散っていた。**共有の time ヘルパが
 * 存在しなかった** ことがその原因なので、まずこのモジュールを作って全部をここへ寄せる。
 *
 * この重複は「読みづらい」以上の危険がある: 誰かが1箇所だけ `add({ days: 1 })` を
 * `+ 86_400_000` に書き換えても、DST の無い Asia/Tokyo では永久にテストが通ってしまう。
 * 日の長さは必ず Temporal に計算させる、という約束をこの1本に閉じ込めておけば、
 * 破るには **このファイルを直す** しかなくなる。
 *
 * ■ なぜ layout/ に置くか
 * 消費側の大半が layout/ の純関数(viewRange/monthGrid/oooDayCoverage/railItems)であり、
 * このリポジトリの依存の向きは sync → layout の一方向で固定されているため
 * (layout から sync を import しているモジュールは1つも無い。同じ理由の説明が
 * layout/oooAllDayPlacement.ts 冒頭にもある)。sync/eventEdit.ts や
 * search/searchOccurrences.ts からこのモジュールを使うのは、その既存の向きに沿っている
 * (sync/reminderSchedule.ts → layout/keys.ts などの前例と同じ)。
 *
 * ■ ここに **無い** もの
 * epoch ms → 表示用の文字列(`formatTime` 等)は layout/gridMetrics.ts に既にまとまっている
 * ので触っていない。あちらは ZonedDateTime の時分を読む「書式化」、こちらは日境界の
 * 「座標変換」で、役割が違う。
 */

/**
 * 1日の分数。レールの全高帯([0, MINUTES_PER_DAY])と、勤務場所の「地」の区間長に使う。
 *
 * 2026-07-31 以前は layout/workingLocationSegments.ts(export)と layout/oooRail.ts(private)に
 * 二重宣言されていて、しかも layout/workingLocationRail.ts が **この定数1つのためだけに**
 * 畳み込み層(workingLocationSegments.ts)を import していた ―― レール層が fold 層に依存する
 * という逆向きの矢印だったので、定数をこの中立な場所へ移して解消した。
 */
export const MINUTES_PER_DAY = 24 * 60;

/**
 * day の 0:00(= その日の始まり)の epoch ms。
 *
 * 0:00 が存在しない日(DST で 0:00→1:00 に飛ぶ地域)でも toZonedDateTime が実際の日の
 * 始まりを返すため、「その日の始まり」の意味が常に保たれる。
 */
export function dayStartMs(day: Temporal.PlainDate, timeZone: string): number {
  return day.toZonedDateTime({ timeZone }).epochMilliseconds;
}

/**
 * [start, start+dayCount日) の epoch ms 半開区間(timeZone の壁時計基準)。
 *
 * dayCount=1 で「その日の 0:00 と翌 0:00」になる ―― 1日ぶんの境界が欲しい呼び出し元は
 * そのまま `dayRangeMs(day, 1, timeZone)` を使う。専用の別名(dayBoundsMs 等)を用意しないのは、
 * 同じ計算に2つの名前が付くのを避けるため(このリファクタで潰した B-5 の型2つと同じ理由)。
 *
 * 終端を `startMs + dayCount * 86_400_000` で出さないのは意図的。DST のある地域では
 * 1日が 23h/25h になるので、日数の足し算は必ず Temporal(壁時計)側で行う。
 */
export function dayRangeMs(
  start: Temporal.PlainDate,
  dayCount: number,
  timeZone: string,
): { startMs: number; endMs: number } {
  return {
    startMs: dayStartMs(start, timeZone),
    endMs: dayStartMs(start.add({ days: dayCount }), timeZone),
  };
}

/** epoch ms が timeZone のどの日に属するか(壁時計のローカル日付) */
export function plainDateOfMs(ms: number, timeZone: string): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(timeZone).toPlainDate();
}

/**
 * 終日予定の日付範囲 [startDate, endDate](両端 inclusive)が dateStr を含むか。
 *
 * ■ なぜ Temporal.PlainDate.compare ではなく文字列比較か(2026-07-31 に統一)
 * 同じ「終日範囲がこの日を含むか」の判定が、layout/oooRail.ts と
 * layout/workingLocationRail.ts では `Temporal.PlainDate.compare`、layout/monthGrid.ts では
 * 文字列比較、と別々のプリミティブで書かれていた。安い方(文字列比較)へ寄せた理由:
 *
 * - 正確さは同じ。startDate/endDate も Temporal.PlainDate.toString() も
 *   ゼロ詰めの "YYYY-MM-DD" 固定長なので、辞書順 = 日付順が厳密に成り立つ
 *   (Google の date は常にこの形、sync/mapGoogle.ts 参照)。
 * - 性能特性は月表示で効く。月グリッドは 42日 × 終日予定の総当たりなので、
 *   PlainDate へ寄せると 1ペアあたり `Temporal.PlainDate.from` を2回 ―― polyfill の
 *   パースを 84×N 回まわすことになる。逆向き(文字列へ寄せる)なら、レール側の
 *   1日あたり 2×N 回のパースも消える。**どちらへ寄せても壊れないが、片方だけが安い。**
 *
 * 呼び出し側は day.toString() をループの外で1回だけ作ること。
 */
export function allDayRangeCoversDate(
  range: { startDate: string; endDate: string },
  dateStr: string,
): boolean {
  return range.startDate <= dateStr && range.endDate >= dateStr;
}
