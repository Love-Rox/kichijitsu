import type { EventAttendee } from "../model/types";

/**
 * 参加者 (ゲスト) の表示用整形 (2026-07-30)。詳細カード (EventDetailCard) が出す
 * 「ゲスト」欄の中身を、Google から来たままの EventAttendee[] から組み立てる純関数層。
 *
 * ここに切り出してあるのは、判断が全部データの話だから ―― 会議室を人から外す、自分と
 * 主催者を先頭へ持ち上げる、表示名が無い相手はメールで代替する、応答が無い行を未返信と
 * みなす。どれもコンポーネントの中に散らすと確かめようがなくなる。
 * コンポーネント側に残すのは「何行まで畳むか」の開閉状態だけ (GUEST_PREVIEW_COUNT)。
 */

/** 一覧に出す応答状態。Google が値を返さない行は未返信 (needsAction) に寄せる (下記 normalize) */
export type GuestResponseStatus = "accepted" | "declined" | "tentative" | "needsAction";

/** 一覧の1行 (人)。会議室は GuestListView.rooms へ分けるのでここには入らない */
export interface GuestRow {
  /** React の key。同じメールが2度出ることは無い前提だが、無い相手のために連番を混ぜる */
  key: string;
  /** 主表示。displayName があればそれ、無ければメール */
  label: string;
  /** displayName があるときだけ、その下に添えるメール (label と重複するときは付けない) */
  subLabel?: string;
  responseStatus: GuestResponseStatus;
  /** 「主催者」「自分」の注記。両方に当たる場合は主催者を優先する (下記 noteFor) */
  note?: string;
}

export interface GuestListView {
  /** 人の行。主催者 → 自分 → 残りは元の順 */
  guests: GuestRow[];
  /** 会議室・機材の表示名。人数にも出欠の内訳にも含めない */
  rooms: string[];
  /** 見出しの人数。例「ゲスト 12人」、打ち切られていれば「ゲスト 50人以上」 */
  countLabel: string;
  /** 出欠の内訳。0人の区分は出さない。例「参加 3・未定 1・未返信 8」 */
  summaryLabel: string;
}

/** 畳んだ状態で見せる行数。これを超えた分は「他 N 人を表示」の中に隠す */
export const GUEST_PREVIEW_COUNT = 5;

/**
 * 応答状態の日本語ラベル。**既存の RSVP ボタン (EventDetailCard の RsvpButtons) と
 * ドキュメントの語彙にそのまま揃える** ―― 参加 / 未定 / 不参加、それに未返信
 * (needsAction)。ここで別の言い方を作らない。
 */
export const GUEST_STATUS_LABEL: Record<GuestResponseStatus, string> = {
  accepted: "参加",
  tentative: "未定",
  declined: "不参加",
  needsAction: "未返信",
};

/** 内訳を並べる順。返事が進んでいる順 (参加 → 未定 → 不参加 → 未返信) */
const STATUS_ORDER: GuestResponseStatus[] = ["accepted", "tentative", "declined", "needsAction"];

/**
 * responseStatus が無い行を「未返信」に寄せる。Google の仕様上 needsAction が
 * 「まだ返事をしていない」状態そのものなので、値が欠けている行を独自の第5の状態として
 * 見せるより、未返信として数えるほうが読み手の理解に合う。
 */
function normalizeStatus(status: EventAttendee["responseStatus"]): GuestResponseStatus {
  return status ?? "needsAction";
}

/**
 * 「主催者」「自分」の注記。両方に当たる (自分が主催の予定) ときは主催者を優先する ――
 * 「主催者・自分」と重ねて出すと注記のほうが名前より長くなるうえ、その行は並び順で
 * 必ず先頭に来るので、自分だと分からなくなる心配は無い。
 */
function noteFor(attendee: EventAttendee): string | undefined {
  if (attendee.organizer === true) return "主催者";
  if (attendee.self === true) return "自分";
  return undefined;
}

/**
 * 会議室・機材 (resource) の表示名。resource は displayName が付いていることがほとんどだが、
 * 無ければメールをそのまま出す (Google が振る会議室のアドレスは長いが、出さないより良い)。
 */
function roomLabel(attendee: EventAttendee): string {
  return attendee.displayName ?? attendee.email ?? "(名称不明の会議室)";
}

function toGuestRow(attendee: EventAttendee, index: number): GuestRow {
  const label = attendee.displayName ?? attendee.email ?? "(不明な参加者)";
  const note = noteFor(attendee);
  return {
    key: `${index}:${attendee.email ?? label}`,
    label,
    // displayName で表示できているときだけメールを添える。displayName が無くて
    // メールを主表示にした行に同じメールをもう一度出しても意味が無い。
    ...(attendee.displayName && attendee.email ? { subLabel: attendee.email } : {}),
    responseStatus: normalizeStatus(attendee.responseStatus),
    ...(note ? { note } : {}),
  };
}

/**
 * 並び順: 主催者 → 自分 → 残りは Google から来た順のまま。
 *
 * 応答状態では並べ替えない ―― 出欠は行ごとの印で読めるので、並びまで動かすと
 * 「さっき上にいた人が返事を変えた途端に下へ飛ぶ」ことになり、同じ予定を何度も開く
 * 使い方では却って探しにくい。主催者と自分だけは常に決まった位置にいるほうが速い。
 */
function guestRank(attendee: EventAttendee): number {
  if (attendee.organizer === true) return 0;
  if (attendee.self === true) return 1;
  return 2;
}

/**
 * 参加者一覧を詳細カードの表示形へ。参加者が1人もいない (attendees が無い/空) 予定は
 * null を返す ―― 呼び出し側は欄ごと出さない (「ゲスト 0人」を出す意味が無いため)。
 * 会議室しかいない予定は null にしない: 「どの部屋を押さえてあるか」は出す価値がある。
 *
 * @param attendeesOmitted 一覧が全員ぶんではない (サーバー側の件数上限で切り詰められた等)。
 *   true のときは人数を断定せず「〜人以上」と出す。内訳 (summaryLabel) は手元にある分の
 *   集計になるが、人数側で不完全であることを示しているので併記してよい。
 */
export function buildGuestListView(
  attendees: EventAttendee[] | undefined,
  attendeesOmitted?: boolean,
): GuestListView | null {
  if (!attendees || attendees.length === 0) return null;

  const people = attendees.filter((a) => a.resource !== true);
  const rooms = attendees.filter((a) => a.resource === true).map(roomLabel);

  // sort は安定 (ES2019 以降) なので、同じ rank の中では元の順が保たれる
  const guests = [...people]
    .sort((a, b) => guestRank(a) - guestRank(b))
    .map((attendee, index) => toGuestRow(attendee, index));

  const counts = new Map<GuestResponseStatus, number>();
  for (const row of guests) {
    counts.set(row.responseStatus, (counts.get(row.responseStatus) ?? 0) + 1);
  }
  const summaryLabel = STATUS_ORDER.filter((status) => (counts.get(status) ?? 0) > 0)
    .map((status) => `${GUEST_STATUS_LABEL[status]} ${counts.get(status)}`)
    .join("・");

  const countLabel = attendeesOmitted
    ? `ゲスト ${guests.length}人以上`
    : `ゲスト ${guests.length}人`;

  return { guests, rooms, countLabel, summaryLabel };
}
