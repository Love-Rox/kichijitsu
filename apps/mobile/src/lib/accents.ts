/**
 * アクセント色の候補は、Web 版と共有する(表は @kichijitsu/web/layout/accentPalette)。
 * ここには、モバイルだけの「外観」(システムに従う / ライト / ダーク)の定義を置く。
 */
export { ACCENTS, ACCENT_KEYS, DEFAULT_ACCENT } from "@kichijitsu/web/layout/accentPalette";
export type { AccentColors, AccentDef, AccentKey } from "@kichijitsu/web/layout/accentPalette";

/** 外観: システムに従う / ライト / ダーク */
export type AppearancePref = "system" | "light" | "dark";
export const APPEARANCES: { key: AppearancePref; label: string }[] = [
  { key: "system", label: "システムに従う" },
  { key: "light", label: "ライト" },
  { key: "dark", label: "ダーク" },
];
