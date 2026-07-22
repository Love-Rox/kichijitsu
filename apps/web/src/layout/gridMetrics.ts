import { Temporal } from "@js-temporal/polyfill";

/**
 * 週グリッドの座標系（px⇔分）と時刻フォーマットを1箇所にまとめる。
 * WeekGrid と EventBlock の両方から参照するため、循環 import を避ける
 * ためだけに独立したモジュールにしてある。
 */

export const HOUR_HEIGHT = 48;
export const DAY_HEIGHT = HOUR_HEIGHT * 24;
export const PX_PER_MINUTE = HOUR_HEIGHT / 60;

/**
 * 日列内のイベント配置(カスケード表示、フェーズ5)の左右ガター。
 * 予定が日の仕切り線に密着しないよう、列の内側にこの px 分だけ余白を持たせる
 * (WeekGrid のカスケード列計算は 0-100% の「使用可能幅」基準で行い、
 * EventBlock 側でこの px インセットと組み合わせて calc() する)。
 * 3px → 5px (2026-07-22): 不在レール (.day-ooo-line) を 4px に太らせるため
 * (ユーザー要望「線が細すぎる」)。レール系 CSS (.day-activity-rail/.day-ci-rail/
 * .day-ooo-rail の width) はこの値にハードコードで追従している。
 */
export const DAY_COLUMN_INSET_PX = 5;

/**
 * 不在(OOO)レール矩形化(2026-07-22 ユーザー要望「もう少し思い切り幅をとり、× の印を
 * 白文字として矩形に収まる形に」)。バー本体の幅。.day-ooo-rail/.day-ooo-line の width と
 * 揃える(WeekGrid.css 側はハードコードのみ許容、値の出どころはここ)。
 */
export const OOO_RAIL_WIDTH_PX = 12;
/** 矩形化した不在バーと予定カードの間に空ける隙間(px) */
const OOO_RAIL_GAP_PX = 4;

/**
 * 日列の左インセット(px)。EventBlock 側の calc(`${leftInsetPx}px + ...`) にそのまま渡す値。
 * その日に不在レールがある(oooItems.length > 0)ときだけ、矩形化した OOO バー(幅
 * OOO_RAIL_WIDTH_PX)+ 隙間(OOO_RAIL_GAP_PX)ぶん広げて予定カードと重ならないようにする
 * (ユーザー要望)。無い日は従来どおり DAY_COLUMN_INSET_PX のまま。右インセットは
 * このバーの有無に関わらず常に DAY_COLUMN_INSET_PX で不変(day-activity-rail は右端固定)。
 * DOM/React に依存しない純関数として切り出し、gridMetrics.test.ts で単体テストする。
 */
export function dayColumnLeftInsetPx(hasOoo: boolean): number {
  return hasOoo ? OOO_RAIL_WIDTH_PX + OOO_RAIL_GAP_PX : DAY_COLUMN_INSET_PX;
}

/** これ未満の分数の予定はコンパクト表示(1行に時刻+タイトル)にする。WeekGrid/DayColumn 共通 */
export const COMPACT_THRESHOLD_MIN = 40;

export function minutesToPx(minutes: number): number {
  return minutes * PX_PER_MINUTE;
}

export function pxToMinutes(px: number): number {
  return px / PX_PER_MINUTE;
}

export function formatTime(ms: number, timeZone: string): string {
  const zdt = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(timeZone);
  return `${zdt.hour}:${String(zdt.minute).padStart(2, "0")}`;
}

/** ドラッグ中のフローティングバッジ用: 「14:00 – 15:00」形式 */
export function formatRange(startMs: number, endMs: number, timeZone: string): string {
  return `${formatTime(startMs, timeZone)} – ${formatTime(endMs, timeZone)}`;
}

/** WeekGrid の曜日ヘッダーと EventBlock の詳細ポップオーバーで共有する曜日ラベル */
export const WEEKDAY_LABELS = ["月", "火", "水", "木", "金", "土", "日"] as const;

/** 詳細ポップオーバー用: 「7月20日(月) 10:00 – 11:00」形式 (曜日込み) */
export function formatDetailDateTime(startMs: number, endMs: number, timeZone: string): string {
  const start = Temporal.Instant.fromEpochMilliseconds(startMs).toZonedDateTimeISO(timeZone);
  const dateLabel = `${start.month}月${start.day}日(${WEEKDAY_LABELS[start.dayOfWeek - 1]})`;
  return `${dateLabel} ${formatRange(startMs, endMs, timeZone)}`;
}

/**
 * 終日予定の詳細ポップオーバー用日付表示 (フェーズ5)。
 * 単日イベントは曜日込みの「7月20日(月)」、複数日にまたがる場合は
 * 「7月20日〜7月22日」形式(endDate は inclusive)。startDate/endDate は
 * ISO calendar date 文字列 (YYYY-MM-DD)、タイムゾーン変換は行わない
 * (終日予定は壁時計の日付そのものを表す)。
 */
export function formatAllDayDateRange(startDate: string, endDate: string): string {
  const start = Temporal.PlainDate.from(startDate);
  const end = Temporal.PlainDate.from(endDate);
  if (start.equals(end)) {
    return `${start.month}月${start.day}日(${WEEKDAY_LABELS[start.dayOfWeek - 1]})`;
  }
  return `${start.month}月${start.day}日〜${end.month}月${end.day}日`;
}

/**
 * 「予定あり」相当の中身のないプレースホルダか。Google が詳細非公開の予定を
 * "Busy" として返すもの、および将来のカレンダーブロック機能が作る「予定あり」ブロック。
 * カスケードでは実予定を覆わないよう無条件に最背面へ回す (ユーザー決定 2026-07-20)。
 */
export function isBusyPlaceholder(title: string): boolean {
  const t = title.trim();
  return t === "Busy" || t === "予定あり";
}

/** [startMs, endMs) の半開区間。overlapsBusy の busyIntervals 引数の要素型 */
export interface TimeInterval {
  startMs: number;
  endMs: number;
}

/**
 * 「予定あり」バッジ判定 (2026-07-20 ユーザー決定): Busy は最背面のままなので
 * 実予定に隠れて見えなくなりうる。その代わり、実予定がいずれかの Busy 区間と
 * 時間的に重なっているかをこの純関数で判定し、重なる実予定側に小さなバッジを出す。
 * 半開区間 [startMs, endMs) 同士の重なり判定なので、端が接するだけ(片方の終了と
 * もう片方の開始が一致)は重なりとみなさない(背中合わせの予定を誤検出しない)。
 */
export function overlapsBusy(
  occ: { startMs: number; endMs: number },
  busyIntervals: readonly TimeInterval[],
): boolean {
  return busyIntervals.some((b) => occ.startMs < b.endMs && occ.endMs > b.startMs);
}

/** 色付き Busy 区間 */
export interface BusyInterval extends TimeInterval {
  color: string;
}

/**
 * occ と時間的に重なる Busy 区間のカレンダー色一覧(重複排除・最大3色)。
 * 実予定カードのバッジに「どのカレンダーの Busy にブロックされているか」を色で示す。
 */
export function busyOverlapColors(
  occ: { startMs: number; endMs: number },
  busyIntervals: readonly BusyInterval[],
  max = 3,
): string[] {
  const colors: string[] = [];
  for (const b of busyIntervals) {
    if (occ.startMs < b.endMs && occ.endMs > b.startMs && !colors.includes(b.color)) {
      colors.push(b.color);
      if (colors.length >= max) break;
    }
  }
  return colors;
}

/**
 * カスケード表示(フェーズ5): 重なる予定は列ごとに等分せず、少しずつ右へ
 * ずらして重ねる(left = column * step, width = 残り全部)。CASCADE_STEP_FRAC は
 * 通常時のずれ幅(使用可能幅に対する割合)、CASCADE_MIN_CARD_FRAC は最前面
 * カード(最後列、常に全幅まで見える)の最低幅 — タイトルが読める下限。
 * 列数が多いときは step を縮めて全カードの左端がグリッド内に収まるようにする。
 * WeekGrid.tsx (通常の予定描画) と DayColumn.tsx (新規作成ドラフトの見た目合わせ) の
 * 両方から使うため、循環 import 回避のためだけの本モジュールに置く。
 */
const CASCADE_STEP_FRAC = 0.14;
const CASCADE_MIN_CARD_FRAC = 0.32;

export function cascadeStepFrac(columnCount: number): number {
  if (columnCount <= 1) return 0;
  return Math.min(CASCADE_STEP_FRAC, (1 - CASCADE_MIN_CARD_FRAC) / (columnCount - 1));
}
