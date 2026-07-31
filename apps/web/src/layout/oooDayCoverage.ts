import { Temporal } from "@js-temporal/polyfill";
import type { AllDayOccurrence, Occurrence } from "../model/types";
import { dayRangeMs, dayStartMs, plainDateOfMs } from "./dayTime";
import type { TimeInterval } from "./gridMetrics";
import type { AllDayOccurrenceGroup, OccurrenceGroup } from "./groupDuplicates";
import { DEFAULT_OOO_ALLDAY_PLACEMENT, type OooAllDayPlacement } from "./oooAllDayPlacement";
import { isOutOfOffice } from "./oooRail";

/**
 * 「1日を丸ごと覆う不在 (OOO)」の判定と、それを終日欄へ載せるための射影
 * (2026-07-29、利用者報告「終日の不在もチェックボックスのオンオフを問わず表示形式が
 * 変わりません」)。
 *
 * ■ なぜ必要か(仕様の切り方を誤っていた)
 * 2026-07-28 に入れた設定 (layout/oooAllDayPlacement.ts) は、振り分けを
 * splitOutOfOfficeAllDayGroups ―― つまり **AllDayOccurrence(start.date を持つ本物の終日予定)
 * だけ** に効かせていた。ところが利用者の実データの不在はすべて `dateTime` の時刻付きで、
 * 1日を丸ごと覆う形になっている:
 *
 *   法定外休日  2026-07-25T00:00:00+09:00 → 2026-07-26T00:00:00+09:00
 *   法定休日    2026-07-26T00:00:00+09:00 → 2026-07-27T00:00:00+09:00
 *   法定外休日  2026-08-01T00:00:00+09:00 → 2026-08-02T00:00:00+09:00
 *
 * これらは終日レーンではなく時刻付きの経路 (splitOutOfOfficeGroups → timedOooRailItems) を
 * 通ってレールの全高ラインになるため、設定の対象に1件も該当せず、切り替えても何も起きなかった。
 *
 * 利用者から見た「終日の不在」は **1日を丸ごと覆う不在** であって、Google の内部表現が
 * `date` か `dateTime` かは関係ない。そこで判定を「その日を 0:00 から翌 0:00 まで覆うか」
 * という時間の事実に置き換える。
 *
 * ■ 判定の規則(境界の扱い)
 * - 基準は **表示タイムゾーンでの1日**。dayStart = day の 0:00、dayEnd = 翌日の 0:00 を
 *   epoch ms で取り、`startMs <= dayStart && endMs >= dayEnd` なら「その日を丸ごと覆う」。
 *   日の長さは Temporal に計算させるので、DST で 23h/25h になる日でも「その日いっぱい」の
 *   意味が保たれる(0:00 が存在しない日でも toZonedDateTime が実際の日の始まりを返す)。
 * - 終了が **翌日 0:00 ちょうど** の場合はその日を覆う扱いで、**翌日は覆わない**
 *   (endMs >= dayEnd(翌日) が成り立たないため)。オフバイワンの温床なので
 *   oooDayCoverage.test.ts で明示的に固定してある。
 * - 丸ごとではない不在(例: 9:00–18:00)は対象外。ここを取り違えると通常の不在まで
 *   終日欄へ移ってしまう ―― これも同テストで固定。
 *
 * ■ 日単位の判定と、複数日をまたぐ1本のバー
 * 判定の基準日は「表示している日」なので、週表示は7日ぶんを別々に判定できる形
 * (coversWholeDay) を基本に置く。一方、終日レーンのバーは複数日を1本の CSS grid 要素で
 * またぐ作りなので、バーを作るときだけは「丸ごと覆う日が連続してどこからどこまでか」
 * (coveredDayRange) が要る。covering は時間区間の性質から必ず連続するので、この2つは
 * 常に一致する(テストで両者の整合も固定してある)。
 *
 * ■ 時刻付きの occurrence をどうやって終日レーンに載せるか → 終日予定の形へ射影する
 * 終日レーンの経路 (buildAllDayPanels → packDayBars → AllDayBar → EventDetailCard) は
 * どれも startDate/endDate だけを見て組み立てられている。ここを合併型に広げると
 * layout/allDayPanels.ts・AllDayBar.tsx・EventDetailCard の各所に分岐が増える一方、
 * 「丸ごと覆う不在」は定義上その日付範囲に等しく、時刻を捨てても情報が落ちない。
 * そこで **射影(toAllDayOooOccurrence)** を選び、経路そのものは一切触っていない
 * (勤務場所を終日レーンへ統合したときと同じ判断の形)。
 *
 * 射影では startMs/endMs/originalStartMs を **意図的に持たせない**。この2つの型は
 * 構造的に見分けられている箇所がいくつもあり(RailBand.tsx の isTimedSubject、
 * DayColumn.tsx のレール振り分け、sync/eventEdit.ts の `"originalStartMs" in subject`)、
 * スプレッドで時刻フィールドを残すと「終日なのに時刻予定として扱われる」事故になるため。
 * 編集・出欠は AllDayBar.tsx が isOutOfOffice の occurrence に対して既に無効化している
 * ので、射影後の日付が Google へ書き戻される経路は存在しない。
 */

/**
 * range が timeZone における day を **丸ごと** 覆うか(0:00 から翌 0:00 まで)。
 * 終了が翌日 0:00 ちょうどならその日は覆う / 翌日は覆わない(上記「境界の扱い」参照)。
 *
 * 引数の型は layout/gridMetrics.ts の TimeInterval(= {startMs, endMs} の半開区間)。
 * 2026-07-31 まではここに TimedRange という **同じ形・同じディレクトリの別名** があったので
 * 消して寄せた(横断レビュー B-5)。「判定に必要な最小の形だからテストから素の値を渡せる」
 * という当時の意図は TimeInterval でもそのまま成り立つ。
 *
 * 日境界(day の 0:00 と翌 0:00)は layout/dayTime.ts の dayRangeMs に任せる ―― 以前は
 * ここに非 export の dayBoundsMs を持っていたが、同じ計算が他に5箇所あった。
 */
export function coversWholeDay(
  range: TimeInterval,
  day: Temporal.PlainDate,
  timeZone: string,
): boolean {
  const bounds = dayRangeMs(day, 1, timeZone);
  return range.startMs <= bounds.startMs && range.endMs >= bounds.endMs;
}

/**
 * range が丸ごと覆う日の連続範囲を [startDate, endDate](両端 inclusive、"YYYY-MM-DD")で返す。
 * 1日も丸ごと覆わなければ null。
 *
 * 両端はそれぞれ次のように決まり、探索も反復も要らない:
 * - first = 「0:00 が startMs 以降になる最初の日」。開始時刻の日は、開始がちょうど 0:00 の
 *   ときだけ自分自身、そうでなければ翌日。
 * - last = 「終了時刻の日の前日」。終了時刻の日そのものは、終了が何時であれ「翌 0:00 まで」に
 *   届かないので必ず候補外(終了が 0:00 ちょうどのケースを含む ―― ここがオフバイワンの温床)。
 *   逆に前日は、終わりの条件(翌 0:00 <= endMs)を常に満たす。
 * first > last なら「丸ごと覆う日は1日も無い」。first <= last なら、その間の日はすべて
 * 両方の条件を満たす(first が始まりの条件を、last が終わりの条件を代表するため)。
 */
export function coveredDayRange(
  range: TimeInterval,
  timeZone: string,
): { startDate: string; endDate: string } | null {
  const startDay = plainDateOfMs(range.startMs, timeZone);
  const endDay = plainDateOfMs(range.endMs, timeZone);

  // 開始がちょうど日の始まりならその日から、そうでなければ翌日から
  const first =
    range.startMs <= dayStartMs(startDay, timeZone) ? startDay : startDay.add({ days: 1 });
  const last = endDay.subtract({ days: 1 });

  if (Temporal.PlainDate.compare(first, last) > 0) return null;
  return { startDate: first.toString(), endDate: last.toString() };
}

/**
 * 時刻付きの不在 group を、その日のレールに残すもの(railGroups)と、1日を丸ごと覆うので
 * 終日欄へ回すもの(dayCoveringGroups)に振り分ける。
 *
 * placement が既定の "timeline" のときは **1件も動かさない** ―― 既存利用者の見え方を
 * 1px も変えないための既定(splitOutOfOfficeAllDayGroups と同じ約束)。
 *
 * 判定が日単位なので、「7/24 15:00 → 7/28 09:00」のように一部の日だけを丸ごと覆う不在は、
 * 丸ごとの日は終日欄のバーに、そうでない日(7/24 の午後)はレールの帯に、と自然に分かれる。
 * どちらの経路も同じ日を二重には描かない。
 */
export function splitDayCoveringOooGroups(
  oooGroups: readonly OccurrenceGroup[],
  day: Temporal.PlainDate,
  timeZone: string,
  placement: OooAllDayPlacement = DEFAULT_OOO_ALLDAY_PLACEMENT,
): { railGroups: OccurrenceGroup[]; dayCoveringGroups: OccurrenceGroup[] } {
  const railGroups: OccurrenceGroup[] = [];
  const dayCoveringGroups: OccurrenceGroup[] = [];
  for (const g of oooGroups) {
    const toAllDay = placement === "allday" && coversWholeDay(g.primary, day, timeZone);
    (toAllDay ? dayCoveringGroups : railGroups).push(g);
  }
  return { railGroups, dayCoveringGroups };
}

/**
 * 時刻付きの occurrence を、終日レーンに載せるための AllDayOccurrence へ射影する。
 * startMs/endMs/originalStartMs は持たせない(このモジュール冒頭の説明を参照)。
 */
function toAllDayOooOccurrence(
  occ: Occurrence,
  startDate: string,
  endDate: string,
): AllDayOccurrence {
  return {
    id: occ.id,
    seriesId: occ.seriesId,
    title: occ.title,
    startDate,
    endDate,
    color: occ.color,
    hasCustomColor: occ.hasCustomColor,
    source: occ.source,
    link: occ.link,
    accountId: occ.accountId,
    calendarId: occ.calendarId,
    iCalUID: occ.iCalUID,
    location: occ.location,
    description: occ.description,
    isMirror: occ.isMirror,
    isOutOfOffice: occ.isOutOfOffice,
    responseStatus: occ.responseStatus,
    isOrganizer: occ.isOrganizer,
    hasConference: occ.hasConference,
    conferenceUrl: occ.conferenceUrl,
    isWorkingLocation: occ.isWorkingLocation,
  };
}

/**
 * 時刻予定の group 一覧から「不在かつ1日を丸ごと覆うもの」だけを取り出し、終日レーンの
 * バーとして描けるよう AllDayOccurrenceGroup へ射影して返す(placement が "allday" のときのみ)。
 *
 * 入力は日で絞り込んでいない group 一覧を渡すこと ―― WeekGrid.tsx の日別フィルタは
 * 「開始時刻がその日に入る予定」だけを拾うため、複数日を覆う不在を日ごとに集めると
 * 2日目以降が落ちてしまう。ここは1本のバーで複数日をまたぐために全体を見る必要がある。
 *
 * group のメンバー(同一予定の複数アカウントコピー)は集約キーに startMs/endMs を含むので
 * 全員が同じ時間範囲を持つ。よって射影する日付範囲も primary と同じもので揃えてよい。
 */
export function dayCoveringOooAllDayGroups(
  groups: readonly OccurrenceGroup[],
  timeZone: string,
  placement: OooAllDayPlacement = DEFAULT_OOO_ALLDAY_PLACEMENT,
): AllDayOccurrenceGroup[] {
  if (placement !== "allday") return [];
  const out: AllDayOccurrenceGroup[] = [];
  for (const g of groups) {
    if (!isOutOfOffice(g.primary)) continue;
    const range = coveredDayRange(g.primary, timeZone);
    if (!range) continue;
    out.push({
      primary: toAllDayOooOccurrence(g.primary, range.startDate, range.endDate),
      members: g.members.map((m) => toAllDayOooOccurrence(m, range.startDate, range.endDate)),
    });
  }
  return out;
}
