/**
 * サイドペインの配置モード。元は GitHub 情報ペイン(GitHubPane、docs/github-integration.md、
 * 旧 WorkQueueDrawer を発展させたセクション式コンテナ)専用に作ったもので、一時期は左ペイン
 * (CalendarPane、カレンダーナビゲーション増分1)も同じ2モードを共有していたが、
 * 「ヘッダー整理+左ペイン常設化」(2026-07-22)でユーザー要望によりオーバーレイ方式を
 * 左ペインから廃止した ―― 左ペインは開いている間は常に docked 固定になり、この型・関数を
 * 使うのは右ペイン(GitHubPane)だけになった。左ペインの狭幅対応は「docked のまま幅だけ
 * CSS で絞る」方式に変わったため、isNarrow によるモードのフォールバック計算はもう不要。
 *
 * overlay は従来通りグリッドに被さる fixed オーバーレイ、docked はグリッドの右に常設する
 * flex サイドバー(グリッド側が flex-shrink して幅を譲る)。
 */
export type PaneMode = "docked" | "overlay";

/**
 * ドッキング常設(docked)は狭幅では窮屈なため選べない — isNarrow のときは常に overlay に
 * フォールバックする。永続化されている PaneMode 自体は書き換えない(広幅に戻れば
 * docked が復元される、App.tsx の paneMode state と isNarrow は別軸)。
 */
export function effectivePaneMode(mode: PaneMode, isNarrow: boolean): PaneMode {
  return isNarrow ? "overlay" : mode;
}

/**
 * 左ペイン(常に docked)を開く直前に、右ペイン(GitHubPane)が実効 overlay として
 * 表示中なら自動的に閉じるべきかを判定する純関数(左ペイン常設化後もユーザー要望で
 * 「左を開くとき右の overlay は閉じる」動線だけは維持する)。逆方向 ―― 右ペインを開く際に
 * 左ペインを閉じる必要は無くなった(左は overlay を持たず、docked 同士は左右で別領域に
 * 常設するため場所が競合しない)。otherOpen かつ effectivePaneMode(otherMode, isNarrow) が
 * "overlay" のときだけ true を返す。
 */
export function shouldCloseOtherPaneOnOpen(
  otherMode: PaneMode,
  otherOpen: boolean,
  isNarrow: boolean,
): boolean {
  return otherOpen && effectivePaneMode(otherMode, isNarrow) === "overlay";
}
