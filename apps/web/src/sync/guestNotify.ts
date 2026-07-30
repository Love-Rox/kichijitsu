import type { EventSendUpdates } from "@kichijitsu/shared";
import type { EventAttendee, Occurrence } from "../model/types";
import { isEditableEventSubject } from "./eventEdit";

/**
 * 予定を**変更**したときのゲストへの通知 (2026-07-31)。ドラッグ移動・編集フォームの保存が
 * Google に渡す `sendUpdates` を決める純関数群。
 *
 * ## 何が問題だったか
 * それまで POST /api/event/patch の経路は `sendUpdates` を一切付けていなかった。公式の
 * パラメータ説明は "Guests who should receive notifications about the event update
 * (for example, title changes, etc.)" ―― 参加者を触らない変更でも効く。つまり
 * **ゲストのいる予定をドラッグで動かしたとき全員にメールが飛ぶのか飛ばないのかが、
 * 公式に文書化されていない既定次第**だった。調べ直しても既定は分からなかった
 * (shared の EventSendUpdates のコメントに調査の結論を書いた) ので、明示的に決める。
 *
 * ## なぜ「送信しない」が `none` ではなく `externalOnly` なのか
 * ゲストの追加・削除 (sync/eventGuests.ts) は `all` 固定だが、**あれは招待、これは更新**で、
 * 必要な値が違う:
 *
 *  - 招待は、届かなければ相手のカレンダーに予定が現れない (だから握り潰せない)。
 *  - 更新は、相手が既にその予定を持っている。Google カレンダーのゲストの複製は
 *    メールとは無関係に Google 側の同期で書き換わる ("changes are propagated to
 *    attendee copies")。**Google カレンダー以外のゲストだけ**がメールでしか更新を
 *    受け取れず、止めると相手のカレンダーが古い時刻のまま残る。
 *
 * よって「知らせなくてよい」の正しい表現は `externalOnly` ("Notifications are sent to
 * non-Google Calendar guests only.")。`none` は kichijitsu のどの経路でも使わない。
 *
 * ## 外部ゲストかどうかは**判定しない**
 * 「このゲストが Google カレンダーを使っているか」は Google が教えてくれない
 * (メールのドメインから推測することもしない ―― Gmail 以外のアドレスで Google カレンダーを
 * 使っている人も、その逆もいる)。判定できないからこそ `externalOnly` に任せるのであって、
 * この層は**ゲストがいるかどうか**しか見ない。
 */

/** 「送信する」「送信しない」の2択。値の意味は shared の EventSendUpdates 参照 */
export type GuestNotify = EventSendUpdates;

/**
 * 確認ダイアログを開いたときに**最初に選ばれている**値 (2026-07-31)。「送信する」。
 * これは UI の初期選択でしかなく、**訊いていない経路の既定ではない**
 * (それは resolveSendUpdates の中にある。混同すると黙ってメールが飛ぶ)。
 *
 * 「送信する」を初期選択にするのは、間違えたときの損害が非対称だから ―― ここが
 * 「送信しない」だと、Enter で確定する癖のある利用者にとっては「動いた会議をゲストが
 * 知らない」が既定になる。逆向きの間違いは余分なメールが1通増えるだけで済む。
 * Google カレンダー自身も更新時の問いかけで「送信」を主たる操作として置いている。
 *
 * **記憶はしない** (端末にも設定にも残さない)。移動の確認ダイアログは元々ドラッグの
 * たびに出るので、そこに選択が1つ増えても操作の回数は変わらない ―― それより、
 * 前に「送信しない」を選んだことを覚えていて、次の**もっと重要な変更**を黙って握り潰す
 * ほうがずっと悪い。Google カレンダーも毎回訊く。
 */
export const DEFAULT_GUEST_NOTIFY: GuestNotify = "all";

/**
 * 通知の判断に必要な、Occurrence/AllDayOccurrence の共通部分だけの形。
 * どちらもこの形を構造的に満たすので、呼び出し側は変換せずそのまま渡せる。
 */
export interface GuestNotifySubject {
  title: string;
  source: Occurrence["source"];
  isMirror?: boolean;
  isOrganizer?: boolean;
  attendees?: EventAttendee[];
}

/**
 * 「知らせる相手」がいるか。**自分自身と会議室・機材は数えない** ――
 * 自分にメールは飛ばないし、会議室は人ではないので通知の宛先にならない
 * (人と設備を分ける数え方は layout/guestList.ts と揃えてある)。
 *
 * attendeesOmitted (50件で打ち切られた予定) は見なくてよい: 打ち切られている時点で
 * 手元の配列も空ではないため、ここは必ず true になる。
 */
export function hasNotifiableGuests(attendees: EventAttendee[] | undefined): boolean {
  return (attendees ?? []).some(
    (attendee) => attendee.self !== true && attendee.resource !== true,
  );
}

/**
 * 通知の可否を**利用者に選ばせるべきか**。true のときだけ確認ダイアログに選択が増える。
 *
 *  - 編集可能な Google 予定であること (mirror・Busy プレースホルダ・ローカル予定は対象外)
 *  - **自分が主催**であること。主催者でない予定を patch しても、公式には
 *    "these changes are only reflected on their own copy" ―― 自分の複製しか変わらず、
 *    誰にも通知は飛ばない。訊く意味が無いので訊かない。
 *  - **知らせる相手がいる**こと (hasNotifiableGuests)。
 *
 * **false のときは何も増やさない**のが絶対条件 ―― ゲストのいない予定・主催者でない予定を
 * 動かす操作 (kichijitsu の操作のほとんど) は 2026-07-31 以前と1つも変わらない。
 * 繰り返し予定かどうかは見ない: 繰り返しの会議を動かしたときこそゲストは知りたい
 * (ゲストの追加・削除と違い、時刻や内容の変更はシリーズ/1回分のどちらでも意味が定まる)。
 */
export function shouldAskGuestNotify(subject: GuestNotifySubject): boolean {
  if (!isEditableEventSubject(subject)) return false;
  if (subject.isOrganizer !== true) return false;
  return hasNotifiableGuests(subject.attendees);
}

/**
 * この変更で Google に渡す `sendUpdates` を確定する。**必ず値を返す** (undefined を返さない)
 * ―― 未文書の既定に落ちる隙間を型の上で塞ぐのがこの関数の役目。
 *
 * 規則はひとつ: **`all` になるのは利用者が確認ダイアログで「送信する」を選んだときだけ**。
 * それ以外は全部 `externalOnly` に倒れる。倒れる先が2種類ある:
 *
 *  - 訊いていない相手 (ゲスト無し・自分が主催でない)。ゲストがいない予定では
 *    **どの値でも Google 側の結果は同じ** (知らせる相手がいない) が、それでも `all` には
 *    しない ―― 手元の attendees が古い (別の端末でゲストが足された直後など) ときに、
 *    頼まれてもいないメールを全員に飛ばしてしまう。`externalOnly` ならその場合でも
 *    外部ゲストのカレンダーだけは正しく直る。
 *  - **訊く前に確定してしまう操作**、つまりカードの下端を掴む**リサイズ** ――
 *    移動と違って確認ダイアログを挟まない (2026-07-22 からの仕様) ので choice が来ない。
 *    ここで DEFAULT_GUEST_NOTIFY に落とすと、**訊いてもいないのに全員へメールが飛ぶ**。
 *    リサイズに新しい問いかけを足すより、黙って送らないほうを採った
 *    (外部ゲストのカレンダーは直り、Google カレンダーのゲストも同期で正しくなる)。
 */
export function resolveSendUpdates(
  subject: GuestNotifySubject,
  choice: GuestNotify | undefined,
): GuestNotify {
  if (!shouldAskGuestNotify(subject)) return "externalOnly";
  return choice ?? "externalOnly";
}
