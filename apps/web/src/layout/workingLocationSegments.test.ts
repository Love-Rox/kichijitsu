import { describe, expect, it } from "vite-plus/test";
import { MINUTES_PER_DAY } from "./dayTime";
import type { RailItem } from "./railItems";
import { foldWorkingLocationDay } from "./workingLocationSegments";

/**
 * 1日ぶんの勤務場所を区間列へ畳む純関数のテスト(2026-07-29、「勤務地の変更前と変更後の
 * 両方が残る」の修正)。
 *
 * subject は「どの予定に由来する区間か」を追えれば十分なので、Occurrence ではなく場所名の
 * 文字列にしてある ―― この層が Occurrence の形を一切見ないこと(地=終日 / 上書き=時刻付きの
 * 区別すら呼び出し元が引数の位置で与えるだけであること)を、この最小型がそのまま示している。
 */

/** テスト用の項目を作る。subject には場所名をそのまま入れて期待値を読みやすくする */
function item(
  id: string,
  place: string,
  startMinutes: number,
  endMinutes: number,
): RailItem<string> {
  return { id, subject: place, groupMembers: [place], startMinutes, endMinutes };
}

/** 地(終日の勤務場所)。範囲は必ず1日全体 */
function base(id: string, place: string): RailItem<string> {
  return item(id, place, 0, MINUTES_PER_DAY);
}

/** 期待値の比較を「場所と区間」だけに絞る小さな射影(id の組み立て規則は別テストで固定する) */
function shape(items: readonly RailItem<string>[]) {
  return items.map((i) => [i.subject, i.startMinutes, i.endMinutes]);
}

const H = 60; // 1時間ぶんの分数(9 * H で 9:00)

describe("foldWorkingLocationDay", () => {
  it("勤務場所が1件も無ければ空配列", () => {
    expect(foldWorkingLocationDay([], [])).toEqual([]);
  });

  it("終日のみ: 1日全体を覆う地1本になる", () => {
    expect(shape(foldWorkingLocationDay([base("wl-home", "自宅")], []))).toEqual([
      ["自宅", 0, MINUTES_PER_DAY],
    ]);
  });

  it("時刻付きのみ: 地が無いので、その区間だけが出る(空き時間を勝手に埋めない)", () => {
    const timed = item("wl-office", "オフィス", 13 * H, 18 * H);
    expect(shape(foldWorkingLocationDay([], [timed]))).toEqual([["オフィス", 13 * H, 18 * H]]);
  });

  it("両方(日の途中を上書き): 地が前後に残り3区間に分かれる ―― 実データ 2026-07-24 の形", () => {
    // 終日=自宅 + 時刻付き=オフィス 13:30–20:00
    const segments = foldWorkingLocationDay(
      [base("wl-home", "自宅")],
      [item("wl-office", "オフィス", 13 * H + 30, 20 * H)],
    );
    expect(shape(segments)).toEqual([
      ["自宅", 0, 13 * H + 30],
      ["オフィス", 13 * H + 30, 20 * H],
      ["自宅", 20 * H, MINUTES_PER_DAY],
    ]);
  });

  it("両方(既定と上書きが逆): 終日オフィス + 時刻付き自宅 ―― 実データ 2026-07-14 の形", () => {
    // どちらが既定でどちらが上書きかは日によって入れ替わる。畳み方は同じで、
    // 「終日が地・時刻付きが上書き」という関係だけで決まる
    const segments = foldWorkingLocationDay(
      [base("wl-office", "オフィス")],
      [item("wl-home", "自宅", 9 * H + 30, 13 * H)],
    );
    expect(shape(segments)).toEqual([
      ["オフィス", 0, 9 * H + 30],
      ["自宅", 9 * H + 30, 13 * H],
      ["オフィス", 13 * H, MINUTES_PER_DAY],
    ]);
  });

  it("時刻付きが日の先頭から: 地は後ろだけに残る(前の断片は作らない)", () => {
    const segments = foldWorkingLocationDay(
      [base("wl-home", "自宅")],
      [item("wl-office", "オフィス", 0, 12 * H)],
    );
    expect(shape(segments)).toEqual([
      ["オフィス", 0, 12 * H],
      ["自宅", 12 * H, MINUTES_PER_DAY],
    ]);
  });

  it("時刻付きが日の末尾まで: 地は前だけに残る", () => {
    const segments = foldWorkingLocationDay(
      [base("wl-home", "自宅")],
      [item("wl-office", "オフィス", 18 * H, MINUTES_PER_DAY)],
    );
    expect(shape(segments)).toEqual([
      ["自宅", 0, 18 * H],
      ["オフィス", 18 * H, MINUTES_PER_DAY],
    ]);
  });

  it("時刻付きが1日を覆い尽くす: 地は完全に消える(二重に出さない)", () => {
    const segments = foldWorkingLocationDay(
      [base("wl-home", "自宅")],
      [item("wl-office", "オフィス", 0, MINUTES_PER_DAY)],
    );
    expect(shape(segments)).toEqual([["オフィス", 0, MINUTES_PER_DAY]]);
  });

  it("時刻付きが複数(重ならない): 地が細切れになり、時刻付きは全て残る", () => {
    // 公式ガイドどおり同じ日に複数の時刻付き勤務場所を持てる
    const segments = foldWorkingLocationDay(
      [base("wl-home", "自宅")],
      [
        item("wl-office-am", "オフィス", 9 * H, 12 * H),
        item("wl-cafe", "カフェ", 15 * H, 17 * H),
      ],
    );
    expect(shape(segments)).toEqual([
      ["自宅", 0, 9 * H],
      ["オフィス", 9 * H, 12 * H],
      ["自宅", 12 * H, 15 * H],
      ["カフェ", 15 * H, 17 * H],
      ["自宅", 17 * H, MINUTES_PER_DAY],
    ]);
  });

  it("時刻付きが複数(隣接): 隙間なく並び、地は前後だけに残る", () => {
    const segments = foldWorkingLocationDay(
      [base("wl-home", "自宅")],
      [item("wl-a", "オフィス", 9 * H, 12 * H), item("wl-b", "カフェ", 12 * H, 15 * H)],
    );
    expect(shape(segments)).toEqual([
      ["自宅", 0, 9 * H],
      ["オフィス", 9 * H, 12 * H],
      ["カフェ", 12 * H, 15 * H],
      ["自宅", 15 * H, MINUTES_PER_DAY],
    ]);
  });

  it("時刻付き同士が部分的に重なる: 後から始まる方が勝ち、先の方は重なった分だけ削れて残る", () => {
    // 公式ガイド "Events which start later take precedence over events which start earlier."
    // ＋ "Partially overlapping events should be shown as two different events"
    const segments = foldWorkingLocationDay(
      [],
      [item("wl-a", "オフィス", 9 * H, 13 * H), item("wl-b", "カフェ", 11 * H, 15 * H)],
    );
    expect(shape(segments)).toEqual([
      ["オフィス", 9 * H, 11 * H],
      ["カフェ", 11 * H, 15 * H],
    ]);
  });

  it("時刻付き同士が部分的に重なる: 入力の順番を入れ替えても結果は同じ(開始時刻だけで決まる)", () => {
    const segments = foldWorkingLocationDay(
      [],
      [item("wl-b", "カフェ", 11 * H, 15 * H), item("wl-a", "オフィス", 9 * H, 13 * H)],
    );
    expect(shape(segments)).toEqual([
      ["オフィス", 9 * H, 11 * H],
      ["カフェ", 11 * H, 15 * H],
    ]);
  });

  it("時刻付きが別の時刻付きに完全に包まれる: 内側が勝ち、外側は前後2つに割れる", () => {
    const segments = foldWorkingLocationDay(
      [],
      [item("wl-outer", "オフィス", 9 * H, 18 * H), item("wl-inner", "自宅", 12 * H, 13 * H)],
    );
    expect(shape(segments)).toEqual([
      ["オフィス", 9 * H, 12 * H],
      ["自宅", 12 * H, 13 * H],
      ["オフィス", 13 * H, 18 * H],
    ]);
  });

  it("時刻付きが同じ時刻に始まる: 短い方が勝ち、長い方も残りが消えない(公式ガイドの duration 優先)", () => {
    // "Events with shorter durations take precedence over those with longer durations."
    // 逆向きに決着させると 9:00–11:00 が丸ごと飲まれて画面から消えてしまう
    const segments = foldWorkingLocationDay(
      [],
      [item("wl-long", "オフィス", 9 * H, 13 * H), item("wl-short", "自宅", 9 * H, 11 * H)],
    );
    expect(shape(segments)).toEqual([
      ["自宅", 9 * H, 11 * H],
      ["オフィス", 11 * H, 13 * H],
    ]);
  });

  it("同じ場所が隣接しても繋げない ―― 区間ごとに由来の予定を保つため(1本にすると詳細を引けなくなる)", () => {
    const segments = foldWorkingLocationDay(
      [base("wl-allday-home", "自宅")],
      [item("wl-timed-home", "自宅", 9 * H, 13 * H)],
    );
    expect(shape(segments)).toEqual([
      ["自宅", 0, 9 * H],
      ["自宅", 9 * H, 13 * H],
      ["自宅", 13 * H, MINUTES_PER_DAY],
    ]);
    // 由来が違うことは id で確かめられる(真ん中だけが時刻付きの予定由来)
    expect(segments.map((s) => s.id)).toEqual([
      "wl-allday-home@0",
      "wl-timed-home@540",
      "wl-allday-home@780",
    ]);
  });

  it("地が2件ある(別カレンダーの終日が同日に並ぶ等): 後ろの1件が勝つ", () => {
    // 終日の勤務場所は1日を超えられない(公式ガイド "All-day working location events cannot
    // span multiple days") ので、同じ日に2件並ぶのは別カレンダー由来くらいしか無い。
    // それでも塗り重ねの規則(配列順で後のものが上)で決着だけは付くようにしてある。
    const segments = foldWorkingLocationDay([base("wl-a", "自宅"), base("wl-b", "オフィス")], []);
    expect(shape(segments)).toEqual([["オフィス", 0, MINUTES_PER_DAY]]);
  });

  it("区間は subject と groupMembers を由来の項目からそのまま引き継ぐ(詳細ポップオーバー用)", () => {
    const src: RailItem<string> = {
      id: "wl-office",
      subject: "オフィス",
      groupMembers: ["オフィス", "オフィス(別アカウントのコピー)"],
      startMinutes: 13 * H,
      endMinutes: 18 * H,
    };
    const segments = foldWorkingLocationDay([base("wl-home", "自宅")], [src]);
    const office = segments.find((s) => s.subject === "オフィス");
    expect(office?.groupMembers).toEqual(src.groupMembers);
    // 分割された地の断片も、元の終日予定の groupMembers を両方の断片が保つ
    expect(segments.filter((s) => s.subject === "自宅").map((s) => s.groupMembers)).toEqual([
      ["自宅"],
      ["自宅"],
    ]);
  });

  it("入力配列を破壊しない(呼び出し元の memo 済み配列をそのまま渡せる)", () => {
    const overrides = [
      item("wl-late", "カフェ", 15 * H, 17 * H),
      item("wl-early", "オフィス", 9 * H, 12 * H),
    ];
    const before = overrides.map((o) => o.id);
    foldWorkingLocationDay([], overrides);
    expect(overrides.map((o) => o.id)).toEqual(before);
  });
});
