/**
 * GitHub 情報ペイン(docs/github-integration.md、旧 WorkQueueDrawer を発展させたセクション式
 * コンテナ)の配置モード。overlay は従来通りグリッドに被さる fixed オーバーレイ、docked は
 * グリッドの右に常設する flex サイドバー(グリッド側が flex-shrink して幅を譲る)。
 */
export type PaneMode = "docked" | "overlay";

/**
 * ドッキング常設(docked)は狭幅では窮屈なため選べない — isNarrow のときは常に overlay に
 * フォールバックする。永続化されている paneMode 自体は書き換えない(広幅に戻れば
 * docked が復元される、App.tsx の paneMode state と isNarrow は別軸)。
 */
export function effectivePaneMode(mode: PaneMode, isNarrow: boolean): PaneMode {
  return isNarrow ? "overlay" : mode;
}
