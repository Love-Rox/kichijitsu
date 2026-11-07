/**
 * UI アイコン集。**Phosphor duotone**(薄い面 + 線を、同じ色で重ねるフラットなアイコン。m-ai-log・
 * モバイルと同じ系統)。形のデータは iconPaths.ts(生成物。`node brand/gen-web-icons.mjs`)。
 * 以前は素朴な自作の線画だったが、系統を揃えるために差し替えた(2026-11-07)。
 *
 * 共通の作法:
 *   - 既定サイズ 14×14(props で上書き可)。色は fill="currentColor" で親の color をそのまま拾う
 *     (ボタン等の hover/focus で color が変われば、アイコンの色も追従する)
 *   - 装飾専用なので常に aria-hidden="true"
 *   - コンポーネント名と props(IconProps)は、差し替え前と同じ(呼び出し側は変えていない)
 * Slack・Meet・Zoom・Teams は、各社のブランドマークなので、この系統に合わせず、下に手書きで残している。
 */
import { ICON_PATHS, ICON_VIEWBOX, type IconPathName } from "./iconPaths";

export interface IconProps {
  /** 既定 14px。ボタン内で文字サイズに合わせたい場合などに上書きする */
  width?: number;
  height?: number;
  className?: string;
}

const DEFAULT_SIZE = 14;

function DuotoneIcon({
  name,
  width = DEFAULT_SIZE,
  height = DEFAULT_SIZE,
  className,
}: IconProps & { name: IconPathName }) {
  return (
    <svg
      width={width}
      height={height}
      viewBox={ICON_VIEWBOX}
      fill="currentColor"
      // 文字と同じ行に置くとき(アイコンだけのボタンも含む)、基準線に載せると、下に字の下端ぶんの
      // すき間ができてアイコンが上にずれ、ボタンも縦に膨らむ。-0.125em は、そのすき間を打ち消す定番の値
      // (flex/grid の子では効かないだけで、害はない)
      style={{ verticalAlign: "-0.125em" }}
      className={className}
      aria-hidden="true"
    >
      {ICON_PATHS[name].map((l, i) => (
        <path key={i} d={l.d} opacity={"opacity" in l ? l.opacity : undefined} />
      ))}
    </svg>
  );
}

/** ピン留め(旧 📌)。GitHubPane のオーバーレイ→常設ドッキング切り替えボタンに使う */
export const PinIcon = (p: IconProps) => <DuotoneIcon name="pin" {...p} />;

/** 重なった枠。常設ドッキング→オーバーレイ(フローティングパネル)切り替えボタンに使う */
export const PanelIcon = (p: IconProps) => <DuotoneIcon name="panel" {...p} />;

/** カレンダー(旧 📅)。ツールバーの左ペイン(CalendarPane)開閉ボタンに使う */
export const CalendarIcon = (p: IconProps) => <DuotoneIcon name="calendar" {...p} />;

/** 歯車(⚙)。アカウント設定ボタンに使う */
export const GearIcon = (p: IconProps) => <DuotoneIcon name="gear" {...p} />;

/** 横三点(その他)。スマホ幅のツールバーで、常時表示しない操作をまとめた「その他」メニューを開くボタンに使う */
export const MoreIcon = (p: IconProps) => <DuotoneIcon name="more" {...p} />;

/** ストップウォッチ(旧 ⏱)。走行中タイマーインジケーターのトグルボタンに使う */
export const TimerIcon = (p: IconProps) => <DuotoneIcon name="timer" {...p} />;

/** タグ(旧 🏷)。ラベル・種別の表示に使う */
export const TagIcon = (p: IconProps) => <DuotoneIcon name="tag" {...p} />;

/** 虫眼鏡(旧 🔍)。検索ボタンに使う */
export const SearchIcon = (p: IconProps) => <DuotoneIcon name="search" {...p} />;

/** 虫眼鏡のマイナス。縦の拡大率を下げるボタンに使う */
export const ZoomOutIcon = (p: IconProps) => <DuotoneIcon name="zoomOut" {...p} />;

/** 虫眼鏡のプラス。縦の拡大率を上げるボタンに使う */
export const ZoomInIcon = (p: IconProps) => <DuotoneIcon name="zoomIn" {...p} />;

/**
 * ビデオカメラ(参加ステータス表示)。会議リンク (conferenceData/hangoutLink) がある予定を示す。
 * EventBlock のタイトル行と EventDetailCard の両方で使う。
 */
export const VideoIcon = (p: IconProps) => <DuotoneIcon name="video" {...p} />;

/**
 * 場所のピン(参加ステータス表示)。location が非空の予定を示す(現地開催の近似 ―― Google API は
 * attendee 単位の参加手段を公開していないため、イベント側の location 有無で代用する)。
 */
export const PlaceIcon = (p: IconProps) => <DuotoneIcon name="place" {...p} />;

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
