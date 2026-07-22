/**
 * サイドペインの配置モード。元は GitHub 情報ペイン(GitHubPane、docs/github-integration.md、
 * 旧 WorkQueueDrawer を発展させたセクション式コンテナ)専用に作ったが、左ペイン
 * (CalendarPane、カレンダーナビゲーション増分1、2026-07-22)も同じ2モードを持つため、
 * この型・関数を左右のペインで共有する(App.tsx 側はペインごとに別々の PaneMode state
 * ―― 右は paneMode、左は leftPaneMode ―― を持ち、どちらもこのモジュールの
 * effectivePaneMode に通す)。
 *
 * overlay は従来通りグリッドに被さる fixed オーバーレイ、docked はグリッドの左右に常設する
 * flex サイドバー(グリッド側が flex-shrink して幅を譲る)。
 */
export type PaneMode = "docked" | "overlay";

/**
 * ドッキング常設(docked)は狭幅では窮屈なため選べない — isNarrow のときは常に overlay に
 * フォールバックする。永続化されている PaneMode 自体は書き換えない(広幅に戻れば
 * docked が復元される、App.tsx の paneMode/leftPaneMode state と isNarrow は別軸)。
 */
export function effectivePaneMode(mode: PaneMode, isNarrow: boolean): PaneMode {
  return isNarrow ? "overlay" : mode;
}

/**
 * 左右のペインが両方 overlay として同時に開けると画面上で重なって煩雑になるため
 * (増分1 仕様: 「片方を開いたらもう片方の overlay は閉じる」)、ペインを開く直前に
 * 「もう片方を閉じるべきか」を判定する純関数。docked 同士は場所が競合しない
 * (左右で別領域に常設する)ため対象外 — もう片方が実際に overlay として表示中
 * (effectivePaneMode が "overlay" になる、かつ開いている)ときだけ true を返す。
 */
export function shouldCloseOtherPaneOnOpen(
  otherMode: PaneMode,
  otherOpen: boolean,
  isNarrow: boolean,
): boolean {
  return otherOpen && effectivePaneMode(otherMode, isNarrow) === "overlay";
}
