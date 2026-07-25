/**
 * フラット SVG ラインアイコン集(2026-07-22、ユーザー要望「pin のアイコンが絵文字なので
 * フラット系に」)。ツールバー/パネルの各所に散らばっていた素の絵文字(📌📅🏷⏱⚙🔍 等)を
 * ここへ集約したインライン SVG に置き換える。ライブラリは追加しない(自作の素朴な線画)。
 *
 * 共通の見た目の作法(全アイコンで揃える):
 *   - viewBox="0 0 16 16"、既定サイズ 14×14(props で上書き可)
 *   - fill="none" + stroke="currentColor"(親要素の color をそのまま拾う。ボタン等の
 *     hover/focus で color が変わればアイコンの色も追従する)
 *   - strokeWidth 1.5、strokeLinecap/strokeLinejoin は "round"(角を立てない、細い墨の線)
 *   - 装飾専用なので常に aria-hidden="true"(呼び出し側でさらに aria-label 等を持つ
 *     button/span に包んでいる場合でも、二重に付けて問題はない)
 */

export interface IconProps {
  /** 既定 14px。ボタン内で文字サイズに合わせたい場合などに上書きする */
  width?: number;
  height?: number;
  className?: string;
}

const DEFAULT_SIZE = 14;

/** ピン留め(旧 📌)。GitHubPane のオーバーレイ→常設ドッキング切り替えボタンに使う */
export function PinIcon({ width = DEFAULT_SIZE, height = DEFAULT_SIZE, className }: IconProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M8 14.2c2.9-3.1 4.8-5.7 4.8-8A4.8 4.8 0 1 0 3.2 6.2c0 2.3 1.9 4.9 4.8 8Z" />
      <circle cx="8" cy="6.2" r="1.5" />
    </svg>
  );
}

/**
 * 重なった枠(旧 ⧉)。常設ドッキング→オーバーレイ(フローティングパネル)切り替えボタンに使う。
 * 2枚の角丸矩形をずらして重ね、「別ウィンドウとして浮かせる」イメージを表す。
 */
export function PanelIcon({ width = DEFAULT_SIZE, height = DEFAULT_SIZE, className }: IconProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2.3" y="2.3" width="8" height="8" rx="1.4" />
      <rect x="5.7" y="5.7" width="8" height="8" rx="1.4" />
    </svg>
  );
}

/** カレンダー(旧 📅)。ツールバーの左ペイン(CalendarPane)開閉ボタンに使う */
export function CalendarIcon({
  width = DEFAULT_SIZE,
  height = DEFAULT_SIZE,
  className,
}: IconProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2.3" y="3.3" width="11.4" height="10.4" rx="1.6" />
      <path d="M2.3 6.6h11.4" />
      <path d="M5.3 2v2.4M10.7 2v2.4" />
    </svg>
  );
}

/**
 * 歯車(⚙)。アカウント設定ボタンに使う。旧実装は「円 + 8方向の放射状の線」で、これは歯車ではなく
 * 太陽(☀)に見えてしまっていた(2026-07-22 差し替え)。Feather の "settings" ギア(ギザギザの歯を
 * 持つ輪郭 + 中央のハブ穴)の正規パスに置き換える。パス座標が 24×24 前提のため viewBox もそれに合わせる
 * (width/height は props でレンダーサイズを制御するので他アイコンと混在しても問題ない)。
 */
export function GearIcon({ width = DEFAULT_SIZE, height = DEFAULT_SIZE, className }: IconProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** ストップウォッチ(旧 ⏱)。走行中タイマーインジケーターのトグルボタンに使う */
export function TimerIcon({ width = DEFAULT_SIZE, height = DEFAULT_SIZE, className }: IconProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M6.2 1.4h3.6" />
      <path d="M8 1.4v1.7" />
      <circle cx="8" cy="9.4" r="5.4" />
      <path d="M8 9.4V6.1" />
    </svg>
  );
}

/** 値札(旧 🏷)。GitHub レーンの release マーカーに使う */
export function TagIcon({ width = DEFAULT_SIZE, height = DEFAULT_SIZE, className }: IconProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M8.7 2.4H4.3a1.9 1.9 0 0 0-1.9 1.9v4.4c0 .5.2 1 .56 1.34l6 6a1.9 1.9 0 0 0 2.68 0l3.06-3.06a1.9 1.9 0 0 0 0-2.68l-6-6a1.9 1.9 0 0 0-1.34-.56Z" />
      <circle cx="5.4" cy="5.4" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 虫眼鏡(旧 🔍)。予定検索ボタンに使う */
export function SearchIcon({ width = DEFAULT_SIZE, height = DEFAULT_SIZE, className }: IconProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="6.8" cy="6.8" r="4.5" />
      <path d="M10.1 10.1L14 14" />
    </svg>
  );
}

/**
 * 虫眼鏡+(ズームイン)/ 虫眼鏡−(ズームアウト)。時間軸ズームの微調整ボタンに使う
 * (2026-07-25、ユーザー要望「−/+ より虫眼鏡に +/− が入ったものがよい」)。
 * SearchIcon と同じ円+柄の骨格に、レンズの中へ横棒(と縦棒)を足しただけ ―― 同じ虫眼鏡の
 * 家族に見えるよう意図的に共通の寸法を使っている。
 */
export function ZoomOutIcon({ width = DEFAULT_SIZE, height = DEFAULT_SIZE, className }: IconProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="6.8" cy="6.8" r="4.5" />
      <path d="M10.1 10.1L14 14" />
      <path d="M4.8 6.8h4" />
    </svg>
  );
}

/** 虫眼鏡+(ズームイン)。ZoomOutIcon のレンズ内に縦棒を足して「+」にしたもの */
export function ZoomInIcon({ width = DEFAULT_SIZE, height = DEFAULT_SIZE, className }: IconProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="6.8" cy="6.8" r="4.5" />
      <path d="M10.1 10.1L14 14" />
      <path d="M4.8 6.8h4M6.8 4.8v4" />
    </svg>
  );
}

/**
 * ビデオカメラ(参加ステータス表示、2026-07-22)。会議リンク (conferenceData/hangoutLink) が
 * ある予定を示す。EventBlock のタイトル行と EventDetailCard の両方で使う
 * (occurrence.hasConference が true のときのみ表示、apps/web/src/components/EventBlock.tsx 参照)。
 */
export function VideoIcon({ width = DEFAULT_SIZE, height = DEFAULT_SIZE, className }: IconProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="1.5" y="4" width="9" height="8" rx="1.4" />
      <path d="M10.5 6.8l3.3-2.1a.6.6 0 0 1 .92.5v5.6a.6.6 0 0 1-.92.5l-3.3-2.1Z" />
    </svg>
  );
}

/**
 * Slack マーク(2026-07-25、Slack ハドル表示)。location に huddle URL が入っている予定
 * (layout/meetingLinks.ts の detectMeetingProvider === "slack")の印として使う。
 *
 * 他アイコンと違い線画ではなく塗り(fill="currentColor" / stroke なし)にしている ――
 * Slack マークは「丸端の4本の棒が風車状に組む」形で、16px で線画にすると内側の輪郭が
 * 潰れて何のマークか判別できないため、単色シルエットで描く方が小サイズで読める
 * (色は他アイコン同様 currentColor 継承なので、置かれた場所のトーンにそのまま馴染む)。
 * パス座標が 24×24 前提なので viewBox もそれに合わせる(GearIcon と同じ扱い ―― レンダー
 * サイズは props の width/height で決まるため他アイコンと混ぜても大きさは揃う)。
 */
export function SlackIcon({ width = DEFAULT_SIZE, height = DEFAULT_SIZE, className }: IconProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      className={className}
      aria-hidden="true"
    >
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
    </svg>
  );
}

/**
 * Google Meet マーク(2026-07-25)。location が Meet URL の予定に使う。
 *
 * 汎用の VideoIcon(線画のカメラ)と並べても見分けが付くよう、こちらは塗りの単色
 * シルエットにし、Meet の特徴である「角丸の本体 + 右へ突き出した三角のノッチ」を
 * 一続きの輪郭として描く(16px では線画にすると本体とノッチの隙間が潰れて
 * ただのカメラに見えてしまうため)。
 */
export function MeetIcon({ width = DEFAULT_SIZE, height = DEFAULT_SIZE, className }: IconProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 16 16"
      fill="currentColor"
      stroke="none"
      className={className}
      aria-hidden="true"
    >
      <path d="M2.6 3.4h5.6A1.6 1.6 0 0 1 9.8 5v1.15l3.1-2.1a.7.7 0 0 1 1.1.58v6.74a.7.7 0 0 1-1.1.58l-3.1-2.1V11A1.6 1.6 0 0 1 8.2 12.6H2.6A1.6 1.6 0 0 1 1 11V5a1.6 1.6 0 0 1 1.6-1.6Z" />
    </svg>
  );
}

/**
 * Zoom マーク(2026-07-25)。location が Zoom URL の予定に使う。
 *
 * Zoom のアプリアイコンは「丸(角丸四角)の中にビデオカメラ」で、この二重構造が
 * 小サイズでも一番識別しやすい。外側の丸だけ線、中のカメラは塗りにすることで
 * 16px でもカメラ形が潰れないようにしている(全部を線にすると内側が黒っぽく詰まる)。
 */
export function ZoomIcon({ width = DEFAULT_SIZE, height = DEFAULT_SIZE, className }: IconProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.6" />
      <path
        d="M4.7 6.2h3.2c.53 0 .95.43.95.95v1.7c0 .53-.42.95-.95.95H4.7a.95.95 0 0 1-.95-.95v-1.7c0-.52.42-.95.95-.95Z"
        fill="currentColor"
        stroke="none"
      />
      <path
        d="M9.5 7.5l1.9-1.25a.55.55 0 0 1 .85.46v2.58a.55.55 0 0 1-.85.46L9.5 8.5Z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

/**
 * Microsoft Teams マーク(2026-07-25)。location が Teams URL の予定に使う。
 *
 * Teams のマークは「白抜きの T を持つ角丸タイル + 右に寄り添う人物シルエット」。
 * T の白抜きは背景色を仮定できない(currentColor 継承のみ)ため、塗りの中を
 * fillRule="evenodd" で本当に抜いて表現している ―― これなら薄墨の上でも
 * 朱の上でも T の形が残る。
 */
export function TeamsIcon({ width = DEFAULT_SIZE, height = DEFAULT_SIZE, className }: IconProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 16 16"
      fill="currentColor"
      stroke="none"
      className={className}
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M1.9 2.9h7.4c.72 0 1.3.58 1.3 1.3v7.6c0 .72-.58 1.3-1.3 1.3H1.9c-.72 0-1.3-.58-1.3-1.3V4.2c0-.72.58-1.3 1.3-1.3Zm1.1 2.3v1.5h1.7v4.6h1.8V6.7h1.7V5.2H3Z"
      />
      <circle cx="12.9" cy="4.4" r="1.9" />
      <path d="M11.6 7.4h1.6c1.55 0 2.8 1.16 2.8 2.6v1.9c0 .66-.56 1.2-1.25 1.2h-1.6c.24-.5.37-1.05.37-1.63V8.7c0-.5-.28-.94-.7-1.18Z" />
    </svg>
  );
}

/**
 * 建物/場所ピン(参加ステータス表示、2026-07-22)。location が非空の予定を示す
 * (現地開催の近似 ―― Google API は attendee 単位の参加手段を公開していないため、
 * イベント側の location 有無で代用する。EventBlock.tsx のコメント参照)。
 */
export function PlaceIcon({ width = DEFAULT_SIZE, height = DEFAULT_SIZE, className }: IconProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M8 14.2c2.9-3.1 4.8-5.7 4.8-8A4.8 4.8 0 1 0 3.2 6.2c0 2.3 1.9 4.9 4.8 8Z" />
      <circle cx="8" cy="6.2" r="1.8" />
    </svg>
  );
}
