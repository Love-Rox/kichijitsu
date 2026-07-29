import { Temporal } from "@js-temporal/polyfill";
import type { AllDayOccurrence, Occurrence } from "./types";
import type { EventSeries, InstanceOverride } from "./series";
import { instanceId } from "./series";

/** mulberry32 — シード付き PRNG。同じシードなら常に同じデータになる */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TITLES = [
  "デザインレビュー",
  "集中作業",
  "コードレビュー",
  "打ち合わせ",
  "スプリント計画",
  "歯医者",
];

const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];

/**
 * 単発ダミーの「場所」プール (2026-07-29、場所の入力補完)。
 *
 * 入力補完 (layout/locationSuggestions.ts) を `?demo=1` で目視確認するには、実データと同じ
 * 「散らかり方」が要る ―― 出現回数の偏り・表記揺れ・URL・場所なしが混ざっていない限り、
 * 並び順も名寄せも除外も画面上では確かめようがない。そこで**重みは要素の重複で表現**して
 * ある (一様乱数で引くので、多く並べたものほど多く出る):
 *
 *   - undefined を多めに: **場所を入れない従来の使い方**が主流のまま(見え方の据え置き確認)。
 *   - 「会議室A」を最多に: 使用回数順で先頭に来ることを確かめる。
 *   - 「会議室Ａ」(全角) / 「会議室 A」(空白入り) を少数: 名寄せされて1件に畳まれ、
 *     表示は多数決で半角の「会議室A」になることを確かめる。
 *   - 「Room A」/「room a」: 大文字小文字の名寄せ。
 *   - Slack ハドル / Zoom / Meet の URL、説明付きの URL: **候補に出ないこと**を確かめる
 *     (実データにある形をそのまま写してある)。
 *   - 日本語の長い住所・施設名: 部分一致(「治療院」と打って当たる)の確認用。
 */
const LOCATIONS: (string | undefined)[] = [
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  "会議室A",
  "会議室A",
  "会議室A",
  "会議室A",
  "会議室A",
  "会議室Ａ",
  "会議室 A",
  "本社 12F 会議室B",
  "本社 12F 会議室B",
  "本社 12F 会議室B",
  "西ヶ原四丁目治療院",
  "西ヶ原四丁目治療院",
  "東京都北区西ヶ原4-51-3 サンプルビル 3F",
  "ドトールコーヒーショップ 西ヶ原店",
  "Room A",
  "room a",
  "https://app.slack.com/huddle/T25JPTN0M/CGDR6P8KW",
  "https://app.slack.com/huddle/T25JPTN0M/CGDR6P8KW",
  "https://zoom.us/j/1234567890",
  "https://meet.google.com/abc-defg-hij",
  "オンライン https://zoom.us/j/9876543210",
];

/** ISO ローカル日時文字列 + タイムゾーンを epoch ms に変換する小さなヘルパー */
function localIsoToEpochMs(iso: string, timeZone: string): number {
  return Temporal.PlainDateTime.from(iso).toZonedDateTime(timeZone).epochMilliseconds;
}

/**
 * シード用の繰り返しシリーズを5〜7個生成する。
 *
 * dtstartIso は「現在(2026-07-19頃)から数週間前」になるよう 2026-06 の
 * 日付をリテラルで固定している(Date.now() 等の実行時刻には一切依存しない
 * = 常に同じ出力になる)。各 dtstart の曜日は対応する RRULE の BYDAY と
 * 整合するように選んである(例: MO,WE シリーズの dtstart は実際に月曜)ので、
 * dtstart 自身が展開結果の最初の1回に一致する ─ exdatesMs / override の
 * ターゲット時刻をここから安全に計算できる。
 */
export function generateDummySeries(timeZone: string): EventSeries[] {
  const standupDtstartIso = "2026-06-15T10:00"; // 月曜
  const standupExcludedMs = localIsoToEpochMs(standupDtstartIso, timeZone);

  return [
    {
      id: "series-standup",
      title: "定例ミーティング",
      color: "#3b82f6",
      source: "local",
      dtstartIso: standupDtstartIso,
      timeZone,
      durationMin: 30,
      rrule: "FREQ=WEEKLY;BYDAY=MO,WE",
      // 初回 (6/15 月) だけ欠番にする
      exdatesMs: [standupExcludedMs],
    },
    {
      id: "series-1on1",
      title: "1on1",
      color: "#8b5cf6",
      source: "local",
      dtstartIso: "2026-06-18T14:00", // 木曜
      timeZone,
      durationMin: 30,
      rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TH",
      exdatesMs: [],
    },
    {
      id: "series-retro",
      title: "ふりかえり",
      color: "#10b981",
      source: "local",
      dtstartIso: "2026-06-26T16:00", // 6月最終金曜
      timeZone,
      durationMin: 60,
      rrule: "FREQ=MONTHLY;BYDAY=-1FR",
      exdatesMs: [],
    },
    {
      id: "series-release",
      title: "リリース会",
      color: "#f59e0b",
      source: "local",
      dtstartIso: "2026-06-09T11:00", // 6月第2火曜
      timeZone,
      durationMin: 45,
      rrule: "FREQ=MONTHLY;BYDAY=2TU",
      exdatesMs: [],
    },
    {
      id: "series-lunch",
      title: "ランチ",
      color: "#06b6d4",
      source: "local",
      dtstartIso: "2026-06-01T12:00", // 毎日
      timeZone,
      durationMin: 60,
      rrule: "FREQ=DAILY",
      exdatesMs: [],
    },
    {
      id: "series-gym",
      title: "ジム",
      color: "#ef4444",
      source: "local",
      dtstartIso: "2026-06-09T07:30", // 火曜
      timeZone,
      durationMin: 45,
      rrule: "FREQ=WEEKLY;BYDAY=TU,FR",
      exdatesMs: [],
    },
  ];
}

/**
 * シード用の InstanceOverride を1件生成する: series-1on1 の初回を
 * 30分後ろ倒しにする部分上書き。対象 series は generateDummySeries の
 * 結果からタイトル通り "series-1on1" を探して使う。
 */
export function generateDummyOverrides(series: EventSeries[]): InstanceOverride[] {
  const target = series.find((s) => s.id === "series-1on1");
  if (!target) return [];

  const originalStartMs = localIsoToEpochMs(target.dtstartIso, target.timeZone);
  const shiftMs = 30 * 60_000;
  const defaultEndMs = originalStartMs + target.durationMin * 60_000;

  return [
    {
      id: instanceId(target.id, originalStartMs),
      seriesId: target.id,
      originalStartMs,
      patch: {
        startMs: originalStartMs + shiftMs,
        endMs: defaultEndMs + shiftMs,
      },
    },
  ];
}

/**
 * 終日予定のダミー (2026-07-28)。
 *
 * 追加理由: 「終日の不在を終日欄に出すかタイムラインに載せるか」の設定
 * (layout/oooAllDayPlacement.ts) を `?demo=1` で目視確認しようにも、従来のデモデータには
 * 終日予定そのものが1件も無く、終日の不在に至っては当然存在しなかった。
 *
 * 他のダミーと違い IndexedDB には保存しない ―― 呼び出し側 (db/bootstrap.ts) が
 * allDayStore へメモリ上で load するだけ(そのため cleanupDemoData の掃除対象にも
 * ならず、実データ運用の環境に残骸が残る余地が無い)。
 *
 * 中身は「不在(終日・単日/複数日)」と「不在ではない通常の終日予定」を混ぜてある ――
 * 設定を切り替えたときに、不在だけが終日レーンとタイムラインの間を行き来し、
 * 通常の終日予定は動かないことを一目で確かめられるようにするため。
 *
 * 2026-07-29「1日の区間として描く」で終日の勤務場所も追加した。日オフセットと意図の対応は
 * generateDummyWorkingLocationOccurrences(下記)のコメントに一覧してある ―― 終日ぶんと
 * 時刻付きぶんが別関数に分かれてしまうため、対応表は片方に集約した。
 */
export function generateDummyAllDayOccurrences(baseDate: Temporal.PlainDate): AllDayOccurrence[] {
  const d = (offset: number) => baseDate.add({ days: offset }).toString();
  /** 終日の勤務場所1件。色は使われない(CSS 側で薄墨固定)が型に必要なので中間色を置く */
  const workingLocation = (id: string, title: string, offset: number): AllDayOccurrence => ({
    id,
    seriesId: null,
    title,
    startDate: d(offset),
    endDate: d(offset), // 公式ガイドどおり終日の勤務場所は1日を超えない
    color: "#6b7280",
    source: "local",
    isWorkingLocation: true,
  });
  return [
    workingLocation("dummy-allday-wl-home-m2", "自宅", -2),
    workingLocation("dummy-allday-wl-office-m1", "オフィス", -1),
    workingLocation("dummy-allday-wl-home-0", "自宅", 0),
    workingLocation("dummy-allday-wl-home-2", "自宅", 2),
    {
      id: "dummy-allday-holiday",
      seriesId: null,
      title: "全社ミーティングデー",
      startDate: d(0),
      endDate: d(0),
      color: "#10b981",
      source: "local",
      // 場所の入力補完 (2026-07-29) が終日予定も供給元にしていることの確認用。
      // 単発ダミー側にある「本社 12F 会議室B」と同じ場所なので、回数が合算される
      location: "本社 12F 会議室B",
    },
    {
      id: "dummy-allday-ooo-single",
      seriesId: null,
      title: "有給休暇",
      startDate: d(1),
      endDate: d(1),
      color: "#ef4444",
      source: "local",
      isOutOfOffice: true,
    },
    {
      id: "dummy-allday-offsite",
      seriesId: null,
      title: "オフサイト合宿",
      startDate: d(2),
      endDate: d(3),
      color: "#3b82f6",
      source: "local",
      // 終日予定にしか出てこない場所(1回だけ使われた場所が候補の末尾に来ることの確認用)
      location: "熱海リゾートホテル 大会議室",
    },
    {
      id: "dummy-allday-ooo-span",
      seriesId: null,
      title: "夏季休暇",
      startDate: d(3),
      endDate: d(4),
      color: "#f59e0b",
      source: "local",
      isOutOfOffice: true,
    },
  ];
}

/**
 * 時刻付きの勤務場所のダミー (2026-07-29「1日の区間として描く」、?demo=1 のときだけ)。
 *
 * 追加理由: 修正前は「同じ日に終日と時刻付きの勤務場所が両方ある」形をデモデータで再現できず、
 * 二重表示もその解消も実ブラウザで確かめられなかった。実データ(2026-07 の勤務場所)で
 * 確認できた形をそのまま写してある。
 *
 * baseDate からの日オフセットと、その日で確かめたいこと(終日ぶんは
 * generateDummyAllDayOccurrences 側にある):
 *
 *   -2  終日=自宅   + 時刻付き=オフィス 13:30–20:00
 *       → 地が前後に残って3区間に割れる(実データ 2026-07-24 の形)
 *   -1  終日=オフィス + 時刻付き=自宅 9:30–13:00
 *       → 既定と上書きが逆でも同じように畳まれる(実データ 2026-07-14 の形)
 *   +0  終日=自宅 のみ
 *       → **時刻付きが無い日は従来どおり終日レーンのチップ**(見え方の据え置き確認)
 *   +2  終日=自宅 + 時刻付き2件(オフィス 9:00–12:00 / カフェ 15:00–17:00)
 *       → 地が細切れになり、時刻付きが複数あっても全て残る
 *
 * 日の選び方: 終日の不在のダミー(+1 の「有給休暇」、+3〜+4 の「夏季休暇」)と重ならない日に
 * 寄せてある。終日の不在は日列レールに常に列0・全高で描かれる(列パッキングの対象外)ので、
 * 同じ日に勤務場所の区間を置くと重なって両方読めなくなり、確認の役に立たないため。
 * 「時刻付きだけがあり終日は無い日」はこの表に入れていない ―― それは今回の変更前から
 * ずっと出ていた形(時刻付きの帯そのもの)で、回帰の心配が無いうえ、区間への畳み込みは
 * layout/workingLocationSegments.test.ts が網羅している。
 *
 * 他のダミー単発予定と同じく id を "dummy-" で始めてあるので、?demo=1 を外した次回起動時に
 * cleanupDemoData (db/database.ts) がまとめて掃除する。
 */
export function generateDummyWorkingLocationOccurrences(
  baseDate: Temporal.PlainDate,
  timeZone: string,
): Occurrence[] {
  /** 時刻付きの勤務場所1件。色は使われない(CSS 側で薄墨固定)が型に必要なので中間色を置く */
  const workingLocation = (
    id: string,
    title: string,
    offset: number,
    startHm: string,
    endHm: string,
  ): Occurrence => {
    const date = baseDate.add({ days: offset }).toString();
    return {
      id,
      seriesId: null,
      title,
      startMs: localIsoToEpochMs(`${date}T${startHm}`, timeZone),
      endMs: localIsoToEpochMs(`${date}T${endHm}`, timeZone),
      color: "#6b7280",
      source: "local",
      isWorkingLocation: true,
    };
  };
  return [
    workingLocation("dummy-wl-office-m2", "オフィス", -2, "13:30", "20:00"),
    workingLocation("dummy-wl-home-m1", "自宅", -1, "09:30", "13:00"),
    workingLocation("dummy-wl-office-2", "オフィス", 2, "09:00", "12:00"),
    workingLocation("dummy-wl-cafe-2", "カフェ", 2, "15:00", "17:00"),
  ];
}

/**
 * 時刻付き (`dateTime`) の不在のダミー (2026-07-29「1日を丸ごと覆う不在」、?demo=1 のときだけ)。
 *
 * 追加理由: 「終日の不在をどこに描くか」の設定 (layout/oooAllDayPlacement.ts) が
 * 「チェックのオンオフを問わず表示形式が変わらない」と報告された原因が、この形のデータを
 * デモで再現できていなかったこと ―― 利用者の実データの不在はすべて時刻付きで、1日を丸ごと
 * 覆う形をしている。Google の内部表現が `date` か `dateTime` かは利用者から見えないので、
 * デモにも両方の形を置いて「どちらも同じように終日欄へ移る」ことを確かめられるようにする。
 *
 * baseDate からの日オフセットと、その日で確かめたいこと:
 *
 *   +5  法定外休日 0:00 → +6 0:00(実データ 2026-07-25 の形)
 *       → **1日を丸ごと覆う時刻付きの不在**。設定 "allday" で終日欄のチップへ移る
 *   +5  通院 9:00–12:00
 *       → **丸ごとではない不在**。設定を切り替えてもレールの帯のまま(同じ日に置いてあるので、
 *          「丸ごとのものだけが移る」ことが1日の中で見比べられる)
 *   +6  夏季連休 +6 0:00 → +8 0:00
 *       → **複数日を丸ごと覆う不在**。覆う日は +6 と +7 の2日(+8 は覆わない)。
 *          終日欄では2日をまたぐ1本のバーになる
 *
 * 日の選び方: 終日の不在のダミー(+1「有給休暇」、+3〜+4「夏季休暇」)とも勤務場所のダミー
 * (-2〜+2)とも重ならない日に寄せてある ―― 既定 (timeline) では不在が日列レールに列0・全高で
 * 描かれ、同じ日の勤務場所の区間と重なって両方読めなくなるため(この重なりは 2026-07-22 の
 * レール導入時からある既存の課題で、今回の変更とは独立)。
 *
 * id は "dummy-" 始まりなので、?demo=1 を外した次回起動時に cleanupDemoData がまとめて掃除する。
 */
export function generateDummyTimedOooOccurrences(
  baseDate: Temporal.PlainDate,
  timeZone: string,
): Occurrence[] {
  /** 時刻付きの不在1件。開始日と終了日を別に取れるようにして「複数日を覆う」形も書ける */
  const ooo = (
    id: string,
    title: string,
    color: string,
    startOffset: number,
    startHm: string,
    endOffset: number,
    endHm: string,
  ): Occurrence => ({
    id,
    seriesId: null,
    title,
    startMs: localIsoToEpochMs(
      `${baseDate.add({ days: startOffset }).toString()}T${startHm}`,
      timeZone,
    ),
    endMs: localIsoToEpochMs(`${baseDate.add({ days: endOffset }).toString()}T${endHm}`, timeZone),
    color,
    source: "local",
    isOutOfOffice: true,
  });
  return [
    ooo("dummy-ooo-timed-fullday", "法定外休日", "#ef4444", 5, "00:00", 6, "00:00"),
    ooo("dummy-ooo-timed-partial", "通院", "#8b5cf6", 5, "09:00", 5, "12:00"),
    ooo("dummy-ooo-timed-span", "夏季連休", "#f59e0b", 6, "00:00", 8, "00:00"),
  ];
}

/**
 * baseDate を含む週から前後 weeks 週ぶんの単発ダミー occurrence を生成する。
 * DAILY シリーズ (ランチ) が既に日々の枠を1つ埋めるため、密度は1日
 * 1〜3個に抑えてある。意図的に重なりクラスタも作り、レイアウトの試験台にする。
 */
export function generateDummyOccurrences(
  baseDate: Temporal.PlainDate,
  timeZone: string,
  weeks = 8,
  seed = 20260719,
): Occurrence[] {
  const rand = mulberry32(seed);
  const out: Occurrence[] = [];
  const startDay = baseDate.subtract({ weeks }).subtract({ days: baseDate.dayOfWeek % 7 });
  const totalDays = weeks * 2 * 7;

  for (let d = 0; d < totalDays; d++) {
    const day = startDay.add({ days: d });
    const count = 1 + Math.floor(rand() * 3); // 1..3 events/day
    for (let i = 0; i < count; i++) {
      const startHour = 8 + Math.floor(rand() * 11); // 8:00..18:00
      const startMin = [0, 15, 30, 45][Math.floor(rand() * 4)];
      const durationMin = [15, 30, 30, 45, 60, 60, 90, 120][Math.floor(rand() * 8)];
      const zdt = day.toZonedDateTime({
        timeZone,
        plainTime: new Temporal.PlainTime(startHour, startMin),
      });
      const startMs = zdt.epochMilliseconds;
      // 場所は「入っていない予定」も多数含むプールから引く(LOCATIONS のコメント参照)。
      // undefined のときはキー自体を生やさない ―― 実データでも location は任意項目で、
      // 場所を入れない従来の使い方をそのまま再現するため
      const location = LOCATIONS[Math.floor(rand() * LOCATIONS.length)];
      out.push({
        id: `dummy-${d}-${i}`,
        seriesId: null,
        title: TITLES[Math.floor(rand() * TITLES.length)],
        startMs,
        endMs: startMs + durationMin * 60_000,
        color: COLORS[Math.floor(rand() * COLORS.length)],
        source: "local",
        ...(location === undefined ? {} : { location }),
      });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}
