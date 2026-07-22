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
