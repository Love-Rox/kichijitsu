import { Temporal } from "@js-temporal/polyfill";

/**
 * 週グリッドの座標系（px⇔分）と時刻フォーマットを1箇所にまとめる。
 * WeekGrid と EventBlock の両方から参照するため、循環 import を避ける
 * ためだけに独立したモジュールにしてある。
 */

/**
 * 時間軸ズーム(2026-07-25)。かつては `HOUR_HEIGHT = 48` / `DAY_HEIGHT` / `PX_PER_MINUTE` の
 * 3定数がこの座標系の出どころだったが、1時間の px 高さをユーザーが調整できるようにしたため
 * 「現在の hourHeight」を呼び出し側から引数で受け取る純関数へ置き換えた。
 *
 * 既定引数はあえて付けていない ―― 既定値でフォールバックできてしまうと「hourHeight を
 * 渡し忘れた箇所だけズームが効かない」というバグが型エラーにならず静かに入り込むため、
 * minutesToPx/pxToMinutes/pxPerMinute はすべて hourHeight を必須引数にしてある
 * (テスト・純関数からは DEFAULT_HOUR_HEIGHT を明示的に渡す)。
 *
 * CSS 側(WeekGrid.css)は同じ値を `--hour-height` カスタムプロパティとして受け取り、
 * 1日ぶんの高さ・時間罫線のグラデーションを calc() で組み立てる。React が
 * .week-grid のインライン style に値を書き込む1箇所だけが CSS 側との接点(WeekGrid.tsx)。
 */
export const DEFAULT_HOUR_HEIGHT = 48;
/** ズームの下限/上限(1時間あたりの px)。ユーザー決定 2026-07-25 */
export const MIN_HOUR_HEIGHT = 24;
export const MAX_HOUR_HEIGHT = 120;
/** −/+ ボタン・⌘/Ctrl+ホイール 1ステップぶんの増減量(px) */
export const HOUR_HEIGHT_STEP = 8;

/**
 * ⌘/Ctrl + ホイールで1ステップ(= HOUR_HEIGHT_STEP ぶん)ズームするのに必要な wheel deltaY の量。
 * トラックパッドのピンチは数〜十数の細かい delta が連続して届くため、生の delta ごとに 8px
 * 動かすと暴走する ―― deltaY を溜めてこのしきい値ぶん貯まるごとに1ステップ進める
 * (accumulateWheelZoom 参照)。
 */
export const WHEEL_ZOOM_DELTA_PER_STEP = 24;

/**
 * wheel の deltaMode(0=pixel、1=line、2=page)を px 相当へ正規化する。
 * Firefox 等の line モードは 1行 ≒ 16px、page モードは1操作で確実にしきい値を超える量として
 * 扱う(どちらも精度は要らない ―― accumulateWheelZoom が1イベント1ステップに丸めるため、
 * 「しきい値を超えるか否か」だけが意味を持つ)。
 */
export function wheelDeltaToPx(deltaY: number, deltaMode: number): number {
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * WHEEL_ZOOM_DELTA_PER_STEP;
  return deltaY;
}

export interface WheelZoomStep {
  /** 次の wheel イベントへ持ち越す蓄積量(px) */
  accumPx: number;
  /** ズームを進める向き。0 = まだしきい値未満(何もしない)、+1 = 縮小方向、-1 = 拡大方向 */
  direction: -1 | 0 | 1;
}

/**
 * ⌘/Ctrl+ホイールのズーム量の蓄積。1イベントで進めるのは最大1ステップに丸める(2026-07-25 修正)。
 *
 * かつては `Math.trunc(accum / しきい値)` のステップ数をそのまま HOUR_HEIGHT_STEP に掛けていたため、
 * マウスホイール1ノッチ(pixel モードで deltaY ≒ 100)で 4 ステップ = 32px も一気に動き、
 * 48px から下限 24px まで飛んでいた(コメントの「1ステップだけ進める」という意図と実装が矛盾)。
 * ステップ数を1に丸め、進めたときは余りを捨てる ―― 余りを持ち越すと蓄積が単調に膨らみ、
 * 逆方向へ回したときに反応するまで何ノッチも必要になるため。
 * これでマウスの1ノッチ・トラックパッドのピンチ(しきい値ぶん貯まった時点)がどちらも
 * 「1操作 = HOUR_HEIGHT_STEP(8px)」の体感になる。
 */
export function accumulateWheelZoom(
  accumPx: number,
  deltaPx: number,
  thresholdPx: number = WHEEL_ZOOM_DELTA_PER_STEP,
): WheelZoomStep {
  const next = accumPx + deltaPx;
  if (Math.abs(next) < thresholdPx) return { accumPx: next, direction: 0 };
  return { accumPx: 0, direction: next > 0 ? 1 : -1 };
}

/** ワンクリックのプリセット(ユーザー決定 2026-07-25)。現在値が一致していればアクティブ表示にする */
export const HOUR_HEIGHT_PRESETS = [
  { id: "compact", label: "コンパクト", short: "小", px: 32 },
  { id: "normal", label: "標準", short: "中", px: DEFAULT_HOUR_HEIGHT },
  { id: "relaxed", label: "ゆったり", short: "大", px: 72 },
] as const;

export type HourHeightPresetId = (typeof HOUR_HEIGHT_PRESETS)[number]["id"];

/** [MIN_HOUR_HEIGHT, MAX_HOUR_HEIGHT] に丸めた整数 px。−/+ とホイールの両方から通す */
export function clampHourHeight(px: number): number {
  return Math.min(MAX_HOUR_HEIGHT, Math.max(MIN_HOUR_HEIGHT, Math.round(px)));
}

/**
 * localStorage 等の外部から来た値を hourHeight として使える形に正規化する。
 * 数値化できない/範囲外/NaN は既定(48)へ丸める(範囲内なら clamp と同じ)。
 * 「プリセット名ではなく実際の px 値を保存する」というユーザー決定に対応して、
 * 保存値は常に px の文字列として扱う。
 */
export function normalizeHourHeight(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_HOUR_HEIGHT;
  if (n < MIN_HOUR_HEIGHT || n > MAX_HOUR_HEIGHT) return DEFAULT_HOUR_HEIGHT;
  return Math.round(n);
}

/** 現在値がどのプリセットと一致するか(一致しなければ null → 呼び出し側は px 値を表示する) */
export function matchHourHeightPreset(hourHeight: number): HourHeightPresetId | null {
  return HOUR_HEIGHT_PRESETS.find((p) => p.px === hourHeight)?.id ?? null;
}

/** 1日(24時間)ぶんの高さ(px)。CSS 側は calc(var(--hour-height) * 24) で同じ値を出す */
export function dayHeightPx(hourHeight: number): number {
  return hourHeight * 24;
}

export function pxPerMinute(hourHeight: number): number {
  return hourHeight / 60;
}

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
 * 不在(OOO)レール・勤務場所レールの帯1本ぶんの幅(px)。2026-07-22 の横ずれ解消
 * リファクタで、それまで別々の定数だった OOO_RAIL_WIDTH_PX / WORKING_LOCATION_RAIL_WIDTH_PX
 * (どちらも値は 12 で同一)を1本化した ―― 両レールは同じ x=0 起点の列を共有し、時間が
 * 重なる帯だけ列パッキング(layout/railStack.ts の packRailBandColumns、packColumns.ts の
 * 貪欲 first-fit を流用)で列を分けて横に並べる。時間が重ならない帯(接触含む)は同じ列
 * (left: 0)に乗り、結果として縦に並ぶ。.day-ooo-line/.day-workloc-band(WeekGrid.css)の
 * width とここが値の出どころ ―― CSS 側はハードコードのみ許容。
 */
export const RAIL_BAND_WIDTH_PX = 12;

/**
 * OOO バー・勤務場所帯の最低表示高さ(px)。両レールとも矩形の中に上端の飾り(OOO の白い
 * × / 勤務場所の PlaceIcon)を収める都合上、長さ0(start===end)や数分の短い帯でも
 * この高さを下回らないようにする。以前は OooRailLine.tsx / WorkingLocationRailBand.tsx が
 * それぞれ独自にローカル定数(MIN_BAR_HEIGHT_PX/MIN_BAND_HEIGHT_PX、どちらも値16)を
 * 持っていたが、railStack.ts の列パッキングが「重なり判定」にもこの値を使う必要が
 * あるため(表示上 16px を占める帯は、実時間が重ならなくても視覚的には重なりうる)、
 * 単一の出どころとしてここへ集約した。
 */
export const RAIL_MIN_BAND_HEIGHT_PX = 16;

/** レール(OOO バー/勤務場所帯)と予定カードの間に空ける隙間(px) */
const RAIL_CARD_GAP_PX = 4;

/**
 * 日列の左インセット(px)。EventBlock 側の calc(`${leftInsetPx}px + ...`) にそのまま渡す値。
 *
 * 2026-07-22 横ずれ解消リファクタ: 以前は「OOO がある/勤務場所があるか」の2択の真偽値
 * ペアから幅を決めていた(=両方ある日は横にずらして 2 レールぶん(30px)確保していた)ため、
 * 同時刻の OOO と勤務場所が横に14pxずれて side-by-side に見える不具合があった。now は
 * OOO と勤務場所を同じ1列(幅 RAIL_BAND_WIDTH_PX)の中で扱い、時間が重なる帯どうしだけ
 * 列パッキングで横に並べる(layout/railStack.ts 参照) ―― そのため必要な横幅は「その日の
 * レールで実際に必要になった最大列数(railColumnCount、DayColumn.tsx が
 * packRailBandColumns の結果から求める)× RAIL_BAND_WIDTH_PX」だけで決まる。
 * railColumnCount===0(その日に OOO も勤務場所も無い)なら従来どおり DAY_COLUMN_INSET_PX
 * のまま。1以上ならレール幅ぶん + カードとの隙間(RAIL_CARD_GAP_PX)を確保する。
 * 右インセットはレールの有無に関わらず常に DAY_COLUMN_INSET_PX で不変(day-activity-rail は
 * 右端固定)。DOM/React に依存しない純関数として切り出し、gridMetrics.test.ts で単体テストする。
 */
export function dayColumnLeftInsetPx(railColumnCount: number): number {
  if (railColumnCount <= 0) return DAY_COLUMN_INSET_PX;
  return railColumnCount * RAIL_BAND_WIDTH_PX + RAIL_CARD_GAP_PX;
}

/**
 * これ未満の高さ(px)の予定カードはコンパクト表示(1行に時刻+タイトル)にする。
 *
 * 時間軸ズーム(2026-07-25)以前は「40分未満」という分単位のしきい値
 * (COMPACT_THRESHOLD_MIN)だったが、コンパクト表示の理由は「2行ぶんの文字が
 * 入る高さが無い」という純粋に見た目の制約なので、ズームすると意味が破綻する
 * (拡大時: 40分=80px もあるのに1行に潰れる/縮小時: 40分=16px でも2行で描こうとする)。
 * そのため px 基準へ移した。値 32px は既定ズーム(48px/h)における従来の 40分と完全に
 * 一致する(40分 × 0.8px/分 = 32px)ので、既定ズームでの見た目は変わらない。
 */
export const COMPACT_THRESHOLD_PX = 32;

/**
 * 予定カード本文の1行の高さ(px)。WeekGrid.css の `.event` の font-size: 12px /
 * line-height: 1.3 と一致させること(どちらかを変えるなら両方直す)。
 */
const EVENT_LINE_HEIGHT_PX = 12 * 1.3;
/** `.event` の上下 padding 合計 (2px × 2) */
const EVENT_VERTICAL_PADDING_PX = 4;
/** 非コンパクト表示で場所行より上に必ず入る行数: 時刻ヘッダー行 + タイトル行(タイトルは常に1行省略) */
const EVENT_LINES_ABOVE_LOCATION = 2;

/**
 * 予定カードの場所テキスト(.event-location-text)を何行まで表示するか(2026-07-25、
 * ユーザー要望「収まるなら折り返して読めるようにしたい」)。
 *
 * 以前は常に `white-space: nowrap` の1行省略で、長い住所が途中で切れて読めなかった。
 * カードの高さ(=予定の長さ × 現在のズーム)から時刻ヘッダー行・タイトル行・padding を
 * 差し引いた残りに入る行数を求め、CSS 変数 `--location-lines` として line-clamp に渡す
 * (EventBlock.tsx)。時間軸ズームで縦に広げたぶんだけ読める行数が増える。
 *
 * 戻り値は最低 1(0行にすると場所が完全に消えてしまい、短い予定で情報が失われる ――
 * 入り切らないぶんはカード自身の overflow: hidden が従来どおりクリップする)。
 * 既定ズーム(48px/h)の1時間の予定は 48px なので従来と同じ1行になる。
 */
export function locationLineClamp(cardHeightPx: number): number {
  const remaining =
    cardHeightPx - EVENT_VERTICAL_PADDING_PX - EVENT_LINES_ABOVE_LOCATION * EVENT_LINE_HEIGHT_PX;
  return Math.max(1, Math.floor(remaining / EVENT_LINE_HEIGHT_PX));
}

export function minutesToPx(minutes: number, hourHeight: number): number {
  return minutes * pxPerMinute(hourHeight);
}

export function pxToMinutes(px: number, hourHeight: number): number {
  return px / pxPerMinute(hourHeight);
}

/**
 * epoch ms → 日列内の縦位置(px)。その日の 0:00 (dayStartMs) からのオフセット。
 *
 * 2026-07-25 の共通化: `minutesToPx((ms - dayStartMs) / 60_000, hourHeight)` という
 * 同じ式が DayColumn/EventBlock/mapActivity/mapCiRuns に9箇所、
 * 高さ側(下の msRangeToHeightPx)が4箇所コピペされていた。正解は sync/planned.ts に
 * あった plannedBlockTopPx / plannedBlockHeightPx(最低4pxの床込み)だったが、
 * 「予定タイムブロック専用」の名前と置き場所のせいで他から使われていなかったため、
 * 座標系の出どころであるこのモジュール(minutesToPx の隣)へ移して汎用名に改めた。
 *
 * hourHeight は既定引数を付けない ―― このモジュール冒頭のコメントどおり、
 * 渡し忘れがズームの効かないバグとして静かに入り込むのを型で防ぐため。
 */
export function msToTopPx(ms: number, dayStartMs: number, hourHeight: number): number {
  return minutesToPx((ms - dayStartMs) / 60_000, hourHeight);
}

/**
 * [startMs, endMs) の長さ → カードの高さ(px)。最低 4px を保証する。
 *
 * 4px の床は「長さ0や数分の予定でも掴める帯として見える」ための下限で、
 * plannedBlockHeightPx から引き継いだ既存挙動(sync/planned.test.ts の期待値と同じ)。
 * レール(OOO/勤務場所)は帯の中に飾りを収める都合でより大きい床
 * (RAIL_MIN_BAND_HEIGHT_PX)を使うため、そちらはこの関数を通さない。
 */
export function msRangeToHeightPx(startMs: number, endMs: number, hourHeight: number): number {
  return Math.max(minutesToPx((endMs - startMs) / 60_000, hourHeight), 4);
}

/**
 * ズーム変更後のスクロール位置(scrollTop)。ズーム前に「ビューポート内 anchorPx の位置に
 * 見えていた時刻」が、ズーム後も同じ位置に留まるように補正する ―― これが無いと拡大/縮小の
 * たびに見ている時間帯が上下へ飛んでしまう。⌘/Ctrl+ホイールではポインタ位置、−/+ ボタンや
 * プリセットではビューポート中央を anchorPx に使う(WeekGrid.tsx)。
 * 戻り値は負にならないよう 0 で下限を切る(先頭付近で縮小したときのため)。
 *
 * 重要: scrollTop / fromHourHeight は必ず「ズームを適用する前」の値を渡すこと。
 * 縮小方向では新しい --hour-height が当たった時点でブラウザが scrollTop を新しい上限へ
 * クランプしてしまうため、適用後に読んだ scrollTop を渡すと基準がずれて 0時付近へ飛ぶ
 * (2026-07-25 修正。WeekGrid.tsx はレンダー中にクランプ前の値をスナップショットしている)。
 */
export function zoomedScrollTop(
  scrollTop: number,
  anchorPx: number,
  fromHourHeight: number,
  toHourHeight: number,
): number {
  const anchorMinutes = pxToMinutes(scrollTop + anchorPx, fromHourHeight);
  return Math.max(0, minutesToPx(anchorMinutes, toHourHeight) - anchorPx);
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
